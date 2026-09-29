'use strict';

const { DEFAULTS } = require('../config.cjs');
const cost = require('./cost.cjs');
const { modelFamily } = require('./index.cjs');
const { readDemand } = require('./demand.cjs');
const { isSystemText } = require('../outcome/transcript.cjs');
const { relay, compactCommand, modelSwitchLine } = require('../next-command.cjs');

const DEFAULT_SETTINGS = DEFAULTS.modelSwitch;

/**
 * Requests in a median turn, measured across 300 real turns: p25 5, p50 22,
 * p75 52, p90 105. A same-family switch must repay within one of these.
 */
const MEDIAN_TURN_REQUESTS = 22;

/**
 * A switch across families saves a share of each task, not of each message, so it is
 * judged over a working session: four median turns.
 */
const SESSION_REQUESTS = 4 * MEDIAN_TURN_REQUESTS;

/**
 * What a request spends besides re-reading its context, measured over 12,665 real
 * requests (whole-context rewrites after a lapse excluded; those are the cache
 * guard's business): a mean 2,900 tokens written to the cache and 2,500 of output.
 */
const WRITE_TOKENS_PER_REQUEST = 2900;
const OUTPUT_TOKENS_PER_REQUEST = 2500;

/**
 * About what a session holds right after /compact. The advice compacts before it
 * switches, so the one-time re-cache on the new model is charged on this, not on the
 * full context. The cache belongs to one model, so every switch re-caches.
 */
const POST_COMPACT_TOKENS = 40000;

/** A typical context, used only to rank models of one family by what a request costs. */
const RANK_TOKENS = 100000;

/**
 * Index points within which two models count as equally good. The index moves by more
 * than this between versions of the same run; a 2-point lead is not worth 9% more per
 * task and half as long again.
 */
const INDEX_TIE = 3;

/**
 * A new work order: the /compact focus names the latest one, not a follow-up like
 * "how do you want to proceed".
 */
const WORK_ORDER = /\b(add|build|implement|create|make|design|architect|plan|planning|measure|integrate|refactor|rewrite|migrate|set ?up|develop|improve|optimi[sz]e|redesign|port|convert|automate|research|audit|investigate|increase|reduce)\b/i;

const money = (n) => `$${n.toFixed(2)}`;

/**
 * Claude Code erases a held prompt (hooks docs: "Blocks prompt processing and erases
 * the prompt"), so the hold hands it back to copy. The reason is shown to the user
 * only and never reaches the model, so this costs no tokens.
 * @param {string} prompt
 */
const giveBack = (prompt) => `\n\nYour message, to send again:\n${prompt.length > 4000 ? `${prompt.slice(0, 3999)}…` : prompt}`;

/**
 * What one typical request costs on `model` with `tokens` of cached context.
 * @param {string|null|undefined} model
 * @param {number} tokens
 * @param {boolean} oneHour
 */
function requestUsd(model, tokens, oneHour) {
  const r = cost.rate(model);
  const read = cost.cacheReadRate(model);
  if (!r || read === null || read === undefined) return null;
  const write = r.in * (oneHour ? 2 : 1.25);
  return (tokens * read + WRITE_TOKENS_PER_REQUEST * write + OUTPUT_TOKENS_PER_REQUEST * r.out) / 1e6;
}

/**
 * Every priced model of a family, newest first — the price table lists each family
 * newest first, and that order is the only notion of "newer" this code trusts.
 * @param {string} family
 */
function familyModels(family) {
  return Object.keys(cost.PRICING).filter((id) => modelFamily(id) === family);
}

/**
 * The model of a family with the cheapest request, the newest on a tie.
 * @param {string} family
 */
function bestOf(family) {
  let best = null;
  let bestUsd = Infinity;
  for (const id of familyModels(family)) {
    const usd = requestUsd(id, RANK_TOKENS, true);
    if (usd !== null && usd < bestUsd) {
      best = id;
      bestUsd = usd;
    }
  }
  return best;
}

/**
 * The model every Opus or Sonnet session should be on, judged per coding task, not
 * per token: among the benchmarked Opus and Sonnet models within INDEX_TIE of the top
 * score, the cheapest per task, the faster on a tie. Today Opus 5.5 — 66 against
 * Sonnet 5.5's 68, but $13.00 a task against $14.20, in 60 minutes against 90: Sonnet
 * is cheaper per token and takes more of them. Fable is never chosen automatically.
 */
/**
 * @typedef {Record<string, {tasks: number, usdPerTask: number}>} Observed
 * Median cost of a complex task per model on the user's own sessions (observed.cjs).
 */

/** Local numbers count only once a model has this many complex tasks on record. */
const { MIN_TASKS: MIN_LOCAL_TASKS } = require('./observed.cjs');

/**
 * Cost per task for each model: the user's own median when every model compared has
 * enough of it, the benchmark otherwise — never a mix, which would compare one
 * workload against another.
 * @param {string[]} models
 * @param {Observed|null|undefined} observed
 */
function taskCosts(models, observed) {
  const local = observed && models.every((m) => observed[m] && observed[m].tasks >= MIN_LOCAL_TASKS);
  /** @type {Record<string, number>} */
  const usd = {};
  for (const m of models) usd[m] = local && observed ? observed[m].usdPerTask : cost.TASK_BENCH[m].usdPerTask;
  return { usd, local: Boolean(local) };
}

/**
 * @param {Observed|null} [observed]
 */
function bestModel(observed = null) {
  const bench = Object.entries(cost.TASK_BENCH).filter(([id]) => ['opus', 'sonnet'].includes(String(modelFamily(id))));
  if (!bench.length) return null;
  const top = Math.max(...bench.map(([, b]) => b.index));
  const fair = bench.filter(([, b]) => b.index >= top - INDEX_TIE);
  const { usd } = taskCosts(fair.map(([id]) => id), observed);
  fair.sort(([ia, a], [ib, b]) => usd[ia] - usd[ib] || a.minutesPerTask - b.minutesPerTask);
  return fair[0][0];
}

/**
 * What switching this session from `model` to `target` is worth per request, what the
 * one-time re-cache on the target costs, and how many requests repay it. `taskRatio`
 * is what a task costs on the target over what it costs here: a model that is cheaper
 * per token but takes more steps is dearer per task, and per-token prices alone
 * would get that backwards.
 *
 * @param {{model?: string|null, tokens?: number, cacheTtl?: '1h'|'5m'|null, target?: string|null, compactFirst?: boolean, taskRatio?: number|null}} input
 */
function switchEconomics(input = {}) {
  const tokens = Number(input.tokens);
  if (!Number.isFinite(tokens) || tokens <= 0) return null;

  const to = input.target || bestModel();
  // An unobserved TTL is priced as the expensive one: never quote a cheaper switch
  // than the user will be billed.
  const oneHour = input.cacheTtl !== '5m';
  const perRequestUsd = requestUsd(input.model, tokens, oneHour);
  const toRate = cost.rate(to);
  const ratio = Number(input.taskRatio);
  const targetPerRequestUsd = Number.isFinite(ratio) && ratio > 0 && perRequestUsd !== null
    ? perRequestUsd * ratio
    : requestUsd(to, tokens, oneHour);
  if (perRequestUsd === null || targetPerRequestUsd === null || !toRate) return null;

  const savedPerRequest = perRequestUsd - targetPerRequestUsd;
  if (savedPerRequest <= 0) return null;

  const cached = input.compactFirst === false ? tokens : Math.min(tokens, POST_COMPACT_TOKENS);
  const recacheUsd = (cached * toRate.in * (oneHour ? 2 : 1.25)) / 1e6;

  return {
    from: cost.normalizeModel(input.model) || String(input.model),
    to: cost.normalizeModel(to) || String(to),
    perRequestUsd,
    targetPerRequestUsd,
    savedPerRequest,
    recacheUsd,
    paybackRequests: Math.ceil(recacheUsd / savedPerRequest),
    oneHour,
  };
}

const minutes = (m) => (m >= 60 ? `${Number((m / 60).toFixed(1))}h` : `${Math.round(m)} min`);

/**
 * Which model this session should be on, and why. Only Opus and Sonnet sessions get
 * an answer, and it does not depend on the message: per task, the best model is the
 * best model whatever the task's size. The message decides only whether to hold it
 * (a task is starting) or just say so (a question, a small edit — see demand.cjs).
 *
 * @param {{model?: string|null, prompt?: string, observed?: Observed|null}} input
 * @returns {{want: string|null, dir: 'same'|'task'|null, why: string, fromPrompt: boolean, taskRatio: number|null}}
 */
function predictModel(input = {}) {
  const none = { want: null, dir: null, why: '', fromPrompt: false, taskRatio: null };
  const family = modelFamily(input.model);
  if (family !== 'opus' && family !== 'sonnet') return none;
  const from = cost.normalizeModel(input.model);
  const to = bestModel(input.observed || null);
  if (!from || !to || from === to || !familyModels(family).includes(from)) return none;
  const holdable = readDemand(String(input.prompt || '')).level !== 'light';

  if (modelFamily(to) === family) {
    const order = familyModels(family);
    if (order.indexOf(to) > order.indexOf(from)) return none; // never step back a version
    const a = requestUsd(from, RANK_TOKENS, true);
    const b = requestUsd(to, RANK_TOKENS, true);
    if (a === null || b === null || b >= a) return none;
    return { want: to, dir: 'same', why: `${to} is newer and cheaper than ${from}`, fromPrompt: holdable, taskRatio: null };
  }

  // Across families: compare whole tasks — on the user's own sessions once both models
  // have enough, from the benchmark until then. A model with no entry is compared
  // through the newest of its family, which is at least as good and no dearer.
  const ref = cost.TASK_BENCH[from] ? from : bestOf(family);
  const a = ref && cost.TASK_BENCH[ref];
  const b = cost.TASK_BENCH[to];
  if (!ref || !a || !b) return none;
  const t = taskCosts([ref, to], input.observed);
  if (t.usd[to] >= t.usd[ref]) return none;
  const refLabel = ref === from ? from : `${ref}, the newest ${family === 'opus' ? 'Opus' : 'Sonnet'}`;
  const source = t.local
    ? `median of your complex tasks (${input.observed?.[to]?.tasks} vs ${input.observed?.[ref]?.tasks})`
    : `in ${minutes(b.minutesPerTask)} vs ${minutes(a.minutesPerTask)}, scoring ${b.index} vs ${a.index} (Coding Agent Index)`;
  return {
    want: to,
    dir: 'task',
    why: `${to} finishes a coding task for ${money(t.usd[to])} vs ${money(t.usd[ref])} on ${refLabel}, ${source}`,
    fromPrompt: holdable,
    taskRatio: t.usd[to] / t.usd[ref],
  };
}

/**
 * The advice for this prompt, decided before it runs, and what to remember. Pure —
 * the hook reads and writes.
 *
 * On any model other than the best one, the first message that starts a task is held
 * — a held prompt costs no tokens — and handed back with the order that keeps the
 * reasoning: /compact on the old model, then /model. Sending it again runs it. Every
 * later reply ends with the same line while the session stays; a question or small
 * edit is never held, only told. A model change re-arms the hold. 'advise' mode never
 * holds. Nothing is said when the switch would not pay back.
 *
 * @param {{
 *   model?: string|null, tokens?: number, cacheTtl?: '1h'|'5m'|null, recent?: object[],
 *   prompt?: string, sessionId?: string|null, now?: number,
 *   state?: {sessionId?: string|null, said?: string, model?: string, heldOn?: string}|null,
 *   settings?: {enabled?: boolean, budgetUsd?: number, hold?: boolean},
 * }} input
 * @returns {{message: string|null, hold: string|null, state: object|null}}
 */
function adviseSessionSwitch(input = {}) {
  const s = { ...DEFAULT_SETTINGS, ...(input.settings || {}) };
  const sessionId = input.sessionId || null;
  const prior = input.state && input.state.sessionId === sessionId ? input.state : null;
  const quiet = { message: null, hold: null, state: prior };
  const prompt = String(input.prompt || '').trim();
  // Slash commands are how the user acts on this advice; never stand in front of them.
  // A system notice (a background task finishing) is not the user's message at all.
  if (!s.enabled || !prompt || prompt.startsWith('/') || isSystemText(prompt)) return quiet;

  const model = String(input.model || '');
  const pred = predictModel(input);
  if (!pred.want) return quiet;

  const econ = switchEconomics({ ...input, target: pred.want, taskRatio: pred.taskRatio });
  const horizon = pred.dir === 'task' ? SESSION_REQUESTS : MEDIAN_TURN_REQUESTS;
  if (!econ || econ.savedPerRequest * horizon < s.budgetUsd || econ.paybackRequests > horizon) return quiet;

  // One hold per model, spent only by a message that was actually held: a question
  // first must not use it up before the task that follows.
  const heldHere = Boolean(prior && prior.heldOn === model);
  const base = { ...(prior || {}), sessionId, said: pred.want, model, at: input.now || Date.now() };
  const prices = pred.dir === 'same' ? ` — ${money(econ.targetPerRequestUsd)} vs ${money(econ.perRequestUsd)} per message` : '';

  if (s.hold && !heldHere && pred.fromPrompt) {
    return {
      message: null,
      hold: `[rcskills] Before this runs: ${pred.why}${prices}. To switch and keep the reasoning: ${compactCommand(prompt)}, `
        + `then /model ${econ.to}, then send this again. To stay on ${econ.from}, just send it again.${giveBack(prompt)}`,
      state: { ...base, heldOn: model },
    };
  }
  const state = base;
  return {
    message: relay(modelSwitchLine({
      focus: prompt,
      to: econ.to,
      why: pred.why,
      fromUsd: pred.dir === 'same' ? econ.perRequestUsd : null,
      toUsd: pred.dir === 'same' ? econ.targetPerRequestUsd : null,
    })),
    hold: null,
    state,
  };
}

module.exports = {
  adviseSessionSwitch,
  predictModel,
  bestModel,
  taskCosts,
  MIN_LOCAL_TASKS,
  bestOf,
  switchEconomics,
  requestUsd,
  MEDIAN_TURN_REQUESTS,
  SESSION_REQUESTS,
  WORK_ORDER,
  WRITE_TOKENS_PER_REQUEST,
  OUTPUT_TOKENS_PER_REQUEST,
  POST_COMPACT_TOKENS,
};
