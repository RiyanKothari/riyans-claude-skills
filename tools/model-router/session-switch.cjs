'use strict';

const { DEFAULTS } = require('../config.cjs');
const cost = require('./cost.cjs');

const DEFAULT_SETTINGS = DEFAULTS.modelSwitch;

/**
 * The model a long session is offered. Sonnet is the cheapest full coding model;
 * Haiku is cheaper still but is not an Opus substitute for the complex work that
 * measurement showed to be 82% of real spend, so it is never suggested for a
 * whole session. Small pieces of work go to Haiku through the router instead.
 */
const TARGET = 'claude-sonnet-5';

/**
 * Requests in a median turn, measured across 300 real turns: p25 5, p50 22,
 * p75 52, p90 105. A switch has to repay inside about one turn to be worth
 * interrupting for, and at 9-14 requests it repays inside half a median one.
 */
const MEDIAN_TURN_REQUESTS = 22;

/** Say it again only once the context has grown this much since the last time. */
const REARM_GROWTH = 1.5;

const k = (n) => `${Math.round(n / 1000)}k`;
const usd = (n) => (n >= 10 ? n.toFixed(0) : n.toFixed(2));

/**
 * What switching this session from `model` to `target` is worth, per request and
 * in total to break even.
 *
 * The dominant cost of a long session is re-reading its own context: measured
 * across 11,709 real requests, 53.8% of spend was cache reads and 25.1% cache
 * writes, against 21.0% for output. Cache reads are billed at a fraction of a
 * model's input rate, so they fall by the same ratio the input rate does - which
 * is why the switch is worth far more than the output-token saving alone.
 *
 * Payback is context-independent: the one-time re-cache and the per-request
 * saving both scale linearly with tokens, so the ratio is a constant - 9 requests
 * on a 5-minute cache, 14 on a one-hour cache.
 *
 * @param {{model?: string|null, tokens?: number, cacheTtl?: '1h'|'5m'|null, target?: string}} input
 * @returns {{
 *   from: string, to: string, perRequestUsd: number, targetPerRequestUsd: number,
 *   savedPerRequest: number, recacheUsd: number, paybackRequests: number, oneHour: boolean,
 * }|null}
 */
function switchEconomics(input = {}) {
  const tokens = Number(input.tokens);
  if (!Number.isFinite(tokens) || tokens <= 0) return null;

  const to = input.target || TARGET;
  const fromRead = cost.cacheReadRate(input.model);
  const toRead = cost.cacheReadRate(to);
  const toRate = cost.rate(to);
  if (!fromRead || !toRead || !toRate) return null;

  const perRequestUsd = (tokens * fromRead) / 1e6;
  const targetPerRequestUsd = (tokens * toRead) / 1e6;
  const savedPerRequest = perRequestUsd - targetPerRequestUsd;
  if (savedPerRequest <= 0) return null;

  // A cache with no observed TTL is assumed to be the expensive one, as the
  // cache guard does: never quote a cheaper switch than the user will be billed.
  const oneHour = input.cacheTtl !== '5m';
  const recacheUsd = (tokens * toRate.in * (oneHour ? 2 : 1.25)) / 1e6;

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

/**
 * Decide whether this session should hear what it is paying for its model, and
 * what to remember about it. Pure - the hook does the reading and writing.
 *
 * The rule this replaced asked whether the last six turns were all small. It
 * fired in 1 of 7 real sessions, at turn 54, covering 8% of spend: small turns
 * are only 8% of the bill, so it was looking in the wrong place. Cost per request
 * is driven by context size and the model's rate, not by how small the last turn
 * was, so that is what is measured here. Small recent work still strengthens the
 * message; it no longer gates it.
 *
 * @param {{
 *   model?: string|null, tokens?: number, cacheTtl?: '1h'|'5m'|null,
 *   allSmall?: boolean, smallCount?: number,
 *   sessionId?: string|null, now?: number,
 *   state?: {sessionId?: string|null, tokens?: number, at?: number}|null,
 *   settings?: {enabled?: boolean, budgetUsd?: number},
 * }} input
 * @returns {{message: string|null, state: object|null}}
 */
function adviseSessionSwitch(input = {}) {
  const s = { ...DEFAULT_SETTINGS, ...(input.settings || {}) };
  const prior = input.state && input.state.sessionId === (input.sessionId || null) ? input.state : null;
  const quiet = { message: null, state: prior };
  if (!s.enabled) return quiet;

  const econ = switchEconomics(input);
  // No economics means an unpriced model, or one already at or below the target's
  // rate - in both cases there is nothing honest to say.
  if (!econ) return quiet;

  const turnSaving = econ.savedPerRequest * MEDIAN_TURN_REQUESTS;
  if (turnSaving < s.budgetUsd) return quiet;

  // Once per session, then again only after real growth.
  if (prior && Number(prior.tokens) > 0 && Number(input.tokens) < Number(prior.tokens) * REARM_GROWTH) {
    return quiet;
  }

  const state = { sessionId: input.sessionId || null, tokens: Number(input.tokens), at: input.now || Date.now() };
  const small = input.allSmall && input.smallCount
    ? ` The last ${input.smallCount} turns were all small work, so nothing here needs ${econ.from}.`
    : '';
  // The re-cache is paid on whatever context is live at the moment of the switch,
  // so a compaction first makes it cheaper as well as smaller.
  const after = econ.recacheUsd >= 0.5
    ? ' Switching costs least right after a /compact, since the re-cache is charged on whatever context is live.'
    : '';

  const message = `[router] This session is on ${econ.from} at ${k(input.tokens)} context: about $${usd(econ.perRequestUsd)} `
    + `per request just to re-read it, ~$${usd(turnSaving)} per median turn more than ${econ.to}.${small} `
    + `Tell the user in one sentence that \`/model sonnet\` costs about $${usd(econ.targetPerRequestUsd)} per request instead — `
    + `the switch re-caches this context once (~$${usd(econ.recacheUsd)}) and repays in ${econ.paybackRequests} requests, `
    + `against a median turn of ${MEDIAN_TURN_REQUESTS} here — and that \`/model opusplan\` keeps ${econ.from} for planning `
    + `and builds on ${econ.to}.${after} The session model is theirs to change; do not switch it for them.`;

  return { message, state };
}

module.exports = {
  adviseSessionSwitch,
  switchEconomics,
  TARGET,
  MEDIAN_TURN_REQUESTS,
  REARM_GROWTH,
};
