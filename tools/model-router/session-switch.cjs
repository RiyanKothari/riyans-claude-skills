'use strict';

const { DEFAULTS } = require('../config.cjs');
const cost = require('./cost.cjs');
const { modelFamily } = require('./index.cjs');
const { readDemand, THINKING } = require('./demand.cjs');
const { actualTier } = require('../outcome/score.cjs');
const { relay, compactCommand, modelSwitchLine, modelUpLine } = require('../next-command.cjs');

const DEFAULT_SETTINGS = DEFAULTS.modelSwitch;

/**
 * Requests in a median turn, measured across 300 real turns: p25 5, p50 22,
 * p75 52, p90 105. A switch must repay within one of these to be worth a hold.
 */
const MEDIAN_TURN_REQUESTS = 22;

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

/** A typical context, used only to rank models by what a request costs. */
const RANK_TOKENS = 100000;

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
 * The model of a family a session should be on: the cheapest per request, the newest
 * on a tie. Today: Opus 5.5 ($4/$20, reads $0.20/M) and Sonnet 5.5 ($2/$10).
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
const bestOpus = () => bestOf('opus');
const bestSonnet = () => bestOf('sonnet');

/**
 * What switching this session from `model` to `target` is worth per request, what the
 * one-time re-cache on the target costs, and how many requests repay it.
 *
 * @param {{model?: string|null, tokens?: number, cacheTtl?: '1h'|'5m'|null, target?: string|null, compactFirst?: boolean}} input
 */
function switchEconomics(input = {}) {
  const tokens = Number(input.tokens);
  if (!Number.isFinite(tokens) || tokens <= 0) return null;

  const to = input.target || bestSonnet();
  // An unobserved TTL is priced as the expensive one: never quote a cheaper switch
  // than the user will be billed.
  const oneHour = input.cacheTtl !== '5m';
  const perRequestUsd = requestUsd(input.model, tokens, oneHour);
  const targetPerRequestUsd = requestUsd(to, tokens, oneHour);
  const toRate = cost.rate(to);
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


/**
 * A move within a family to a model that is both newer and cheaper, or null. Such a
 * move never costs quality, so it needs nothing from the prompt.
 * @param {string|null|undefined} model
 */
function sameFamilyUpgrade(model) {
  const family = modelFamily(model);
  const from = cost.normalizeModel(model);
  if (!family || !from) return null;
  const to = bestOf(family);
  const order = familyModels(family);
  if (!to || from === to || !order.includes(from) || order.indexOf(to) > order.indexOf(from)) return null;
  const a = requestUsd(from, RANK_TOKENS, true);
  const b = requestUsd(to, RANK_TOKENS, true);
  return a !== null && b !== null && b < a ? to : null;
}

/**
 * Which model this message should run on, judged from the message itself — any kind
 * of request, not only ones like past turns (see demand.cjs). Only Opus and Sonnet
 * sessions get an answer.
 *
 * Sonnet 5.5 is the default: on agentic coding it is on par with Opus, or a little
 * weaker, at about a third less per message. Opus 5.5 is kept for thinking — reasoning,
 * judgement, diagnosing a failure. So: Sonnet → the best Opus before a thinking message
 * (held once); Opus → the best Sonnet when a new message is anything else. A go-ahead
 * ("yes", "continue") or an unclear message changes nothing: the switch happens where
 * work starts, never in the middle of it, so switches — each a re-cache and a reasoning
 * handoff — stay rare. Otherwise an older, dearer model of the same family → its
 * newest, cheapest one. `fromPrompt` says the message itself decided it.
 *
 * @param {{model?: string|null, recent?: object[], prompt?: string}} input
 * @returns {{want: string|null, dir: 'down'|'up'|'same'|null, why: string, fromPrompt: boolean}}
 */
function predictModel(input = {}) {
  const none = { want: null, dir: null, why: '', fromPrompt: false };
  const family = modelFamily(input.model);
  const d = readDemand(String(input.prompt || ''));
  const thinking = THINKING.has(d.kind);
  const midTask = d.kind === 'continuation' || d.kind === 'unclear';
  const upgrade = sameFamilyUpgrade(input.model);
  const same = upgrade
    ? { want: upgrade, dir: /** @type {'same'} */ ('same'), why: `${upgrade} is newer and cheaper than ${cost.normalizeModel(input.model)}`, fromPrompt: true }
    : none;

  if (family === 'opus') {
    const sonnet = bestSonnet();
    if (sonnet && !thinking && !midTask) {
      const why = d.level === 'light' ? `this is small work: ${d.why}` : `this is building, not reasoning: ${d.why}`;
      return { want: sonnet, dir: 'down', why, fromPrompt: true };
    }
    return same;
  }
  if (family === 'sonnet') {
    const opus = bestOpus();
    if (opus && thinking) return { want: opus, dir: 'up', why: d.why, fromPrompt: true };
    return same;
  }
  return none;
}

/**
 * The advice for this prompt, decided before it runs, and what to remember. Pure —
 * the hook reads and writes.
 *
 * Every message is judged on its own: small work on Opus → Sonnet 5.5, Opus work on
 * Sonnet → Opus 5.5, an older model → the newest of its family. The first time a
 * recommendation is made on a model, the message is held — a held prompt costs no
 * tokens — and handed back; sending it again runs it. While the same recommendation
 * stands, every later reply ends with it (~40 tokens) and nothing is held again. A
 * model change re-arms the hold. Stepping down names the order that keeps the
 * reasoning: /compact while still on the old model, then /model. 'advise' mode never
 * holds.
 *
 * @param {{
 *   model?: string|null, tokens?: number, cacheTtl?: '1h'|'5m'|null, recent?: object[],
 *   prompt?: string, sessionId?: string|null, now?: number,
 *   state?: {sessionId?: string|null, said?: string, model?: string}|null,
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
  if (!s.enabled || !prompt || prompt.startsWith('/')) return quiet;

  const model = String(input.model || '');
  const from = cost.normalizeModel(model) || model;
  const pred = predictModel(input);
  if (!pred.want) return quiet;

  // At most one hold per model, whatever it recommended: alternating small and big
  // messages must not hold every other one. Every message still gets its line.
  const heldHere = Boolean(prior && prior.model === model);
  const state = heldHere ? { ...prior, said: pred.want } : { sessionId, said: pred.want, model, at: input.now || Date.now() };
  const hold = s.hold && !heldHere;

  if (pred.dir === 'up') {
    if (pred.fromPrompt && hold) {
      return {
        message: null,
        hold: `[rcskills] Before this runs: this message needs Opus — ${pred.why}. Run \`/model ${pred.want}\`, `
          + `then send it again. The reasoning carries over. To run it on ${from} anyway, just send it again.${giveBack(prompt)}`,
        state,
      };
    }
    return { message: relay(modelUpLine({ to: pred.want, why: pred.why })), hold: null, state };
  }

  // Down, or a newer and cheaper model of the same family: it must pay.
  const econ = switchEconomics({ ...input, target: pred.want });
  if (!econ || econ.savedPerRequest * MEDIAN_TURN_REQUESTS < s.budgetUsd) return quiet;
  if (econ.paybackRequests > MEDIAN_TURN_REQUESTS) return quiet;
  if (hold) {
    return {
      message: null,
      hold: `[rcskills] Before this runs: ${pred.why} — ${econ.to} costs ${money(econ.targetPerRequestUsd)} vs `
        + `${money(econ.perRequestUsd)} per message. To switch and keep the reasoning: ${compactCommand(prompt)}, `
        + `then /model ${econ.to}, then send this again. To stay on ${econ.from}, just send it again.${giveBack(prompt)}`,
      state,
    };
  }
  return {
    message: relay(modelSwitchLine({ focus: prompt, to: econ.to, why: pred.why, fromUsd: econ.perRequestUsd, toUsd: econ.targetPerRequestUsd })),
    hold: null,
    state,
  };
}

/**
 * Replay the policy over real sessions, in order, as if every recommendation had
 * been followed. Sonnet is the default, so complex work on Sonnet is expected; the
 * number that matters is thinking messages — reasoning, diagnosis — that ran on
 * Sonnet, and how often the user would have been asked to switch.
 *
 * @param {Array<Array<{prompt: string, edits: number, commands: number, reads: number, distinctFiles: number}>>} sessions
 */
function replaySwitchPolicy(sessions) {
  const out = { turns: 0, onSonnet: 0, complexOnSonnet: 0, thinkingOnSonnet: 0, thinking: 0, down: 0, up: 0, held: 0 };
  for (const turns of sessions) {
    let model = bestOpus() || 'claude-opus-5-5';
    for (let i = 0; i < turns.length; i++) {
      const pred = predictModel({ model, recent: turns.slice(Math.max(0, i - 8), i), prompt: turns[i].prompt });
      if (pred.want) {
        model = pred.want;
        if (pred.dir === 'down') out.down++;
        if (pred.dir === 'up') out.up++;
        if (pred.fromPrompt) out.held++;
      }
      out.turns++;
      const thinking = THINKING.has(readDemand(String(turns[i].prompt || '')).kind);
      if (thinking) out.thinking++;
      if (modelFamily(model) === 'sonnet') {
        out.onSonnet++;
        if (actualTier(turns[i]) === 'complex') out.complexOnSonnet++;
        if (thinking) out.thinkingOnSonnet++;
      }
    }
  }
  return out;
}

function formatReplay(r) {
  const pct = (n, of) => (of ? `${Math.round((100 * n) / of)}%` : '0%');
  return [
    `model switching, replayed over ${r.turns} turns as if every recommendation were followed:`,
    `  turns on Sonnet 5.5:    ${r.onSonnet} (${pct(r.onSonnet, r.turns)} of all turns), ${r.complexOnSonnet} of them complex builds`,
    `  thinking on Sonnet:     ${r.thinkingOnSonnet} of ${r.thinking} reasoning or diagnosis messages — the degradation risk`,
    `  switches:               ${r.down} down, ${r.up} up (${r.held} decided before the work ran)`,
  ].join('\n');
}

module.exports = {
  adviseSessionSwitch,
  predictModel,
  readDemand,
  bestOpus,
  bestSonnet,
  switchEconomics,
  requestUsd,
  replaySwitchPolicy,
  formatReplay,
  MEDIAN_TURN_REQUESTS,

  WORK_ORDER,
  WRITE_TOKENS_PER_REQUEST,
  OUTPUT_TOKENS_PER_REQUEST,
  POST_COMPACT_TOKENS,
};
