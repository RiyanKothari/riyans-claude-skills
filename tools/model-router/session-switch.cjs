'use strict';

const { DEFAULTS } = require('../config.cjs');
const cost = require('./cost.cjs');
const { classify, modelFamily, HARD_SIGNALS } = require('./index.cjs');
const { actualTier } = require('../outcome/score.cjs');
const { relay, compactCommand, modelDownLine, modelUpLine } = require('../next-command.cjs');

const DEFAULT_SETTINGS = DEFAULTS.modelSwitch;

/**
 * The model an Opus session steps down to. Sonnet is the cheapest full coding model.
 * Only Opus sessions are ever advised: the point is to spend Opus where it earns its
 * price and nowhere else, never to push a session below Sonnet.
 */
const TARGET = 'claude-sonnet-5';

/**
 * Requests in a median turn, measured across 300 real turns: p25 5, p50 22,
 * p75 52, p90 105. A switch must repay within one of these to be worth a hold.
 */
const MEDIAN_TURN_REQUESTS = 22;

/**
 * What a request spends besides re-reading its context, measured over 12,665 real
 * requests (whole-context rewrites after a lapse excluded; those are the cache
 * guard's business): a mean 2,900 tokens written to the cache and 2,500 of output.
 * Pricing a switch on cache reads alone was right for Opus 5 and wrong for Opus 5.5,
 * which reads its cache at Sonnet's $0.20/M: there the whole saving is here.
 */
const WRITE_TOKENS_PER_REQUEST = 2900;
const OUTPUT_TOKENS_PER_REQUEST = 2500;

/**
 * About what a session holds right after /compact. The advice compacts before it
 * switches, so the one-time re-cache on the new model is charged on this, not on the
 * full context: at 400k on Opus 5.5 that is the difference between a 44-request and a
 * 5-request payback.
 */
const POST_COMPACT_TOKENS = 40000;

/**
 * Completed small turns needed before stepping down. Replayed over 344 real turns,
 * the prompt alone put complex work on Sonnet 29% of the time — wording cannot see
 * how big a job will get — while 3 measured small turns plus a small-reading prompt
 * put it there 2% of the time. 4 turns was no safer; 2 doubled the misses.
 */
const SMALL_RUN = 3;

/**
 * A new work order reads short but starts big: "add a setting…", "measure how
 * often…", "architect the product…" were most of the complex turns the tier rule
 * sent to Sonnet. These verbs keep a session on Opus, or bring it back. A trivial
 * edit ("add a comment", "rename") is exempt — the router already knows those.
 */
const WORK_ORDER = /\b(add|build|implement|create|make|design|architect|plan|planning|measure|integrate|refactor|rewrite|migrate|set ?up|develop|improve|optimi[sz]e|redesign|port|convert|automate|research|audit|investigate|increase|reduce)\b/i;

const SMALL = new Set(['trivial', 'simple']);
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
 * What switching this session from `model` to `target` is worth per request, what the
 * one-time re-cache on the target costs, and how many requests repay it.
 *
 * @param {{model?: string|null, tokens?: number, cacheTtl?: '1h'|'5m'|null, target?: string, compactFirst?: boolean}} input
 */
function switchEconomics(input = {}) {
  const tokens = Number(input.tokens);
  if (!Number.isFinite(tokens) || tokens <= 0) return null;

  const to = input.target || TARGET;
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
    to: cost.normalizeModel(to) || to,
    perRequestUsd,
    targetPerRequestUsd,
    savedPerRequest,
    recacheUsd,
    paybackRequests: Math.ceil(recacheUsd / savedPerRequest),
    oneHour,
  };
}

/** What a prompt says about the work it is about to start. */
function readPrompt(prompt) {
  const text = String(prompt || '');
  const c = classify(text);
  const trivialEdit = c.matched.some((m) => m.signal === 'trivial-edit');
  return {
    tier: c.tier,
    hard: c.matched.some((m) => HARD_SIGNALS.has(m.signal)),
    workOrder: WORK_ORDER.test(text) && !trivialEdit,
  };
}

/**
 * Which model the next turn should run on, judged from what the session has really
 * done and what this prompt asks for. Only Opus and Sonnet sessions get an answer.
 *
 * Down to Sonnet: the last SMALL_RUN completed turns were all small, and this prompt
 * is not complex, not reasoning-heavy and not a new work order.
 * Up to Opus: this prompt is any of those, or the last turn turned out complex.
 * `fromPrompt` says the answer was reached before the turn ran, so it can be held.
 *
 * @param {{model?: string|null, recent?: object[], prompt?: string}} input
 * @returns {{want: 'sonnet'|'opus'|null, why: string, fromPrompt: boolean}}
 */
function predictModel(input = {}) {
  const family = modelFamily(input.model);
  const recent = Array.isArray(input.recent) ? input.recent : [];
  const tiers = recent.map((t) => actualTier(t));
  const p = readPrompt(input.prompt);

  const reasons = [];
  if (p.tier === 'complex') reasons.push('it reads as complex work');
  if (p.hard) reasons.push('it asks for deep reasoning');
  if (p.workOrder) reasons.push('it starts new work');
  const promptNeedsOpus = reasons.length > 0;
  const lastComplex = tiers.length > 0 && tiers[tiers.length - 1] === 'complex';

  if (family === 'opus') {
    const run = tiers.slice(-SMALL_RUN);
    if (promptNeedsOpus || run.length < SMALL_RUN || !run.every((t) => SMALL.has(t))) {
      return { want: null, why: '', fromPrompt: false };
    }
    return { want: 'sonnet', why: `the last ${SMALL_RUN} turns were small and this one reads small`, fromPrompt: true };
  }
  if (family === 'sonnet') {
    if (promptNeedsOpus) return { want: 'opus', why: reasons.join(' and '), fromPrompt: true };
    if (lastComplex) return { want: 'opus', why: 'the last turn turned out to be complex', fromPrompt: false };
  }
  return { want: null, why: '', fromPrompt: false };
}

/**
 * The advice for this prompt, decided before it runs, and what to remember. Pure —
 * the hook reads and writes.
 *
 * When the prompt itself shows which model it needs, the message is held, once,
 * before any model sees it — a held prompt costs no tokens — and the user is told
 * what to switch to. Sending it again runs it as it is. Stepping down names the
 * order that keeps the reasoning: /compact while still on Opus (Opus writes the
 * summary, and the re-cache on Sonnet is charged on the small result), then /model
 * sonnet. 'advise' mode relays the same thing as the reply's last line instead.
 *
 * A message is held at most once per recommendation per model: sending it again runs
 * it. From then on, every message the recommendation still stands gets it as the
 * reply's last line (~40 tokens), so the user is prompted after each message rather
 * than once, and is never held twice. A model change re-arms the hold.
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
  const pred = predictModel(input);
  if (!pred.want) return quiet;
  const repeat = Boolean(prior && prior.said === pred.want && prior.model === model);
  const state = repeat ? prior : { sessionId, said: pred.want, model, at: input.now || Date.now() };
  const hold = s.hold && !repeat;

  if (pred.want === 'sonnet') {
    const econ = switchEconomics(input);
    if (!econ || econ.savedPerRequest * MEDIAN_TURN_REQUESTS < s.budgetUsd) return quiet;
    if (econ.paybackRequests > MEDIAN_TURN_REQUESTS) return quiet;
    if (hold) {
      return {
        message: null,
        hold: `[rcskills] Before this runs: ${pred.why}. Sonnet does it for ${money(econ.targetPerRequestUsd)} `
          + `vs ${money(econ.perRequestUsd)} per message. To switch and keep the reasoning: ${compactCommand(prompt)}, `
          + `then /model sonnet, then send this again. To run it on ${econ.from}, just send it again.${giveBack(prompt)}`,
        state,
      };
    }
    return {
      message: relay(modelDownLine({ focus: prompt, why: pred.why, fromUsd: econ.perRequestUsd, toUsd: econ.targetPerRequestUsd })),
      hold: null,
      state,
    };
  }

  if (pred.fromPrompt && hold) {
    return {
      message: null,
      hold: `[rcskills] Before this runs: this session is on Sonnet and this message needs Opus — ${pred.why}. `
        + 'Run `/model opus`, then send it again. The reasoning carries over. '
        + `To run it on Sonnet anyway, just send it again.${giveBack(prompt)}`,
      state,
    };
  }
  return { message: relay(modelUpLine({ why: pred.why })), hold: null, state };
}

/**
 * Replay the policy over real sessions, in order, as if every recommendation had
 * been followed. The number that matters is complex turns that ran on Sonnet: each
 * is a job a weaker model did that Opus should have done.
 *
 * @param {Array<Array<{prompt: string, edits: number, commands: number, reads: number, distinctFiles: number}>>} sessions
 */
function replaySwitchPolicy(sessions) {
  const out = { turns: 0, onSonnet: 0, complexOnSonnet: 0, moderateOnSonnet: 0, down: 0, up: 0, held: 0 };
  for (const turns of sessions) {
    let model = 'claude-opus-5';
    for (let i = 0; i < turns.length; i++) {
      const pred = predictModel({ model, recent: turns.slice(Math.max(0, i - 8), i), prompt: turns[i].prompt });
      if (pred.want === 'sonnet') {
        model = TARGET;
        out.down++;
      } else if (pred.want === 'opus') {
        model = 'claude-opus-5';
        out.up++;
      }
      if (pred.want && pred.fromPrompt) out.held++;
      out.turns++;
      if (modelFamily(model) === 'sonnet') {
        out.onSonnet++;
        const tier = actualTier(turns[i]);
        if (tier === 'complex') out.complexOnSonnet++;
        if (tier === 'moderate') out.moderateOnSonnet++;
      }
    }
  }
  return out;
}

function formatReplay(r) {
  const pct = (n) => (r.onSonnet ? `${Math.round((100 * n) / r.onSonnet)}%` : '0%');
  return [
    `model switching, replayed over ${r.turns} turns as if every recommendation were followed:`,
    `  turns on Sonnet:        ${r.onSonnet} (${r.turns ? Math.round((100 * r.onSonnet) / r.turns) : 0}% of all turns)`,
    `  complex work on Sonnet: ${r.complexOnSonnet} (${pct(r.complexOnSonnet)} of Sonnet turns) — the degradation risk`,
    `  moderate on Sonnet:     ${r.moderateOnSonnet} (${pct(r.moderateOnSonnet)})`,
    `  switches:               ${r.down} down, ${r.up} up (${r.held} decided before the work ran)`,
  ].join('\n');
}

module.exports = {
  adviseSessionSwitch,
  predictModel,
  readPrompt,
  switchEconomics,
  requestUsd,
  replaySwitchPolicy,
  formatReplay,
  TARGET,
  MEDIAN_TURN_REQUESTS,
  SMALL_RUN,
  WORK_ORDER,
  WRITE_TOKENS_PER_REQUEST,
  OUTPUT_TOKENS_PER_REQUEST,
  POST_COMPACT_TOKENS,
};
