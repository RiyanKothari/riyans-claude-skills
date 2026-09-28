'use strict';

const { DEFAULTS } = require('../config.cjs');
const cost = require('./cost.cjs');
const { modelFamily } = require('./index.cjs');
const { relay, compactCommand, modelSwitchLine } = require('../next-command.cjs');

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
 * Every priced Opus model, newest first — the price table lists each family newest
 * first, and that order is the only notion of "newer" this code trusts.
 */
function opusModels() {
  return Object.keys(cost.PRICING).filter((id) => modelFamily(id) === 'opus');
}

/**
 * The Opus a session should be on: the cheapest per request, the newest on a tie.
 * Today that is Opus 5.5 ($4/$20, cache reads $0.20/M) against $5/$25 for Opus 5,
 * 4.8, 4.7, 4.6 and 4.5, and $15/$75 for 4.1 and 4.
 */
function bestOpus() {
  let best = null;
  let bestUsd = Infinity;
  for (const id of opusModels()) {
    const usd = requestUsd(id, RANK_TOKENS, true);
    if (usd !== null && usd < bestUsd) {
      best = id;
      bestUsd = usd;
    }
  }
  return best;
}

/**
 * What switching this session from `model` to `target` is worth per request, what the
 * one-time re-cache on the target costs, and how many requests repay it.
 *
 * @param {{model?: string|null, tokens?: number, cacheTtl?: '1h'|'5m'|null, target?: string|null, compactFirst?: boolean}} input
 */
function switchEconomics(input = {}) {
  const tokens = Number(input.tokens);
  if (!Number.isFinite(tokens) || tokens <= 0) return null;

  const to = input.target || bestOpus();
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
 * Which Opus this session should be on. Only Opus sessions get an answer, and only
 * ever a move to an Opus that is both newer and cheaper — so no message can land on
 * a weaker model, and there is nothing to guess from the prompt. Sonnet is never
 * suggested. A model newer than the price table is left alone.
 *
 * @param {{model?: string|null}} input
 * @returns {{want: string|null, why: string}}
 */
function predictModel(input = {}) {
  const none = { want: null, why: '' };
  if (modelFamily(input.model) !== 'opus') return none;
  const from = cost.normalizeModel(input.model);
  const to = bestOpus();
  const order = opusModels();
  if (!from || !to || from === to || !order.includes(from)) return none;
  if (order.indexOf(to) > order.indexOf(from)) return none; // never step back a version
  const a = requestUsd(from, RANK_TOKENS, true);
  const b = requestUsd(to, RANK_TOKENS, true);
  if (a === null || b === null || b >= a) return none;
  return { want: to, why: `${to} is newer and cheaper than ${from}` };
}

/**
 * The advice for this prompt, decided before it runs, and what to remember. Pure —
 * the hook reads and writes.
 *
 * The first message that would run on a dearer, older Opus is held — a held prompt
 * costs no tokens — with the order that keeps the reasoning: /compact while still on
 * the old model, then /model <best Opus>. Sending it again runs it as it is. From then
 * on, every reply ends with the same line while the session stays on that model, so
 * the user is prompted after each message and never held twice. 'advise' mode only
 * relays the line. A model change re-arms the hold.
 *
 * @param {{
 *   model?: string|null, tokens?: number, cacheTtl?: '1h'|'5m'|null,
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
  const econ = switchEconomics({ ...input, target: pred.want });
  if (!econ || econ.savedPerRequest * MEDIAN_TURN_REQUESTS < s.budgetUsd) return quiet;
  if (econ.paybackRequests > MEDIAN_TURN_REQUESTS) return quiet;

  const repeat = Boolean(prior && prior.said === pred.want && prior.model === model);
  const state = repeat ? prior : { sessionId, said: pred.want, model, at: input.now || Date.now() };

  if (s.hold && !repeat) {
    return {
      message: null,
      hold: `[rcskills] Before this runs: ${pred.why} — ${money(econ.targetPerRequestUsd)} vs `
        + `${money(econ.perRequestUsd)} per message. To switch and keep the reasoning: ${compactCommand(prompt)}, `
        + `then /model ${econ.to}, then send this again. To stay on ${econ.from}, just send it again.${giveBack(prompt)}`,
      state,
    };
  }
  return {
    message: relay(modelSwitchLine({ focus: prompt, from: econ.from, to: econ.to, fromUsd: econ.perRequestUsd, toUsd: econ.targetPerRequestUsd })),
    hold: null,
    state,
  };
}

module.exports = {
  adviseSessionSwitch,
  predictModel,
  bestOpus,
  switchEconomics,
  requestUsd,
  MEDIAN_TURN_REQUESTS,
  WORK_ORDER,
  WRITE_TOKENS_PER_REQUEST,
  OUTPUT_TOKENS_PER_REQUEST,
  POST_COMPACT_TOKENS,
};
