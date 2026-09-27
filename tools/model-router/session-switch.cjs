'use strict';

const { DEFAULTS } = require('../config.cjs');
const cost = require('./cost.cjs');
const { classify, modelFamily, HARD_SIGNALS } = require('./index.cjs');
const { actualTier } = require('../outcome/score.cjs');

const DEFAULT_SETTINGS = DEFAULTS.modelSwitch;

/**
 * The model an Opus session steps down to. Sonnet is the cheapest full coding model.
 * Only Opus sessions are ever advised: the point is to spend Opus where it earns its
 * price and nowhere else, never to push a session below Sonnet.
 */
const TARGET = 'claude-sonnet-5';

/**
 * Requests in a median turn, measured across 300 real turns: p25 5, p50 22,
 * p75 52, p90 105. Used to express a per-request saving as a per-turn one.
 */
const MEDIAN_TURN_REQUESTS = 22;

/**
 * Completed small turns needed before stepping down. Replayed over 316 real turns,
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
const k = (n) => `${Math.round(n / 1000)}k`;
const usd = (n) => (n >= 10 ? n.toFixed(0) : n.toFixed(2));
const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * What switching this session from `model` to `target` is worth. Payback is
 * context-independent: the one-time re-cache and the per-request saving both scale
 * with tokens — 9 requests on a 5-minute cache, 14 on a one-hour cache.
 *
 * @param {{model?: string|null, tokens?: number, cacheTtl?: '1h'|'5m'|null, target?: string}} input
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

  // An unobserved TTL is priced as the expensive one: never quote a cheaper switch
  // than the user will be billed.
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
    return {
      want: 'sonnet',
      why: `the last ${SMALL_RUN} turns were small and this one reads small`,
      fromPrompt: false,
    };
  }
  if (family === 'sonnet') {
    if (promptNeedsOpus) return { want: 'opus', why: reasons.join(' and '), fromPrompt: true };
    if (lastComplex) return { want: 'opus', why: 'the last turn turned out to be complex', fromPrompt: false };
  }
  return { want: null, why: '', fromPrompt: false };
}

/**
 * The advice for this prompt, and what to remember. Pure — the hook reads and writes.
 *
 * Going down is a saving, so it is a line Claude relays at the end of its reply,
 * with the order that keeps the reasoning: `/compact` while still on Opus, so the
 * stronger model writes the summary and the re-cache shrinks, then `/model sonnet`.
 * Going up protects the outcome, so when this very prompt needs Opus the message is
 * held once and the user is asked to switch first; sending it again goes through.
 * Each recommendation is made once per model; it re-arms when the model changes.
 *
 * @param {{
 *   model?: string|null, tokens?: number, cacheTtl?: '1h'|'5m'|null, recent?: object[],
 *   prompt?: string, sessionId?: string|null, now?: number,
 *   state?: {sessionId?: string|null, said?: string, model?: string, heldPrompt?: string}|null,
 *   settings?: {enabled?: boolean, budgetUsd?: number, hold?: boolean},
 * }} input
 * @returns {{message: string|null, hold: string|null, state: object|null}}
 */
function adviseSessionSwitch(input = {}) {
  const s = { ...DEFAULT_SETTINGS, ...(input.settings || {}) };
  const sessionId = input.sessionId || null;
  const prior = input.state && input.state.sessionId === sessionId ? input.state : null;
  const quiet = { message: null, hold: null, state: prior };
  if (!s.enabled) return quiet;

  const model = String(input.model || '');
  const pred = predictModel(input);
  if (!pred.want) return quiet;
  // Once per recommendation per model: the same advice is not repeated while the user
  // is still deciding, and a new model starts the count again.
  if (prior && prior.said === pred.want && prior.model === model) return quiet;
  const state = { sessionId, said: pred.want, model, at: input.now || Date.now() };

  if (pred.want === 'sonnet') {
    const econ = switchEconomics(input);
    if (!econ || econ.savedPerRequest * MEDIAN_TURN_REQUESTS < s.budgetUsd) return quiet;
    const focus = clip(input.prompt, 60);
    const afterCompact = switchEconomics({ ...input, tokens: Math.min(Number(input.tokens), 40000) });
    const message = `[router] Model: the next messages can run on Sonnet — ${pred.why}. `
      + `At the end of your reply, tell the user in two short lines: this session re-reads ${k(Number(input.tokens))} `
      + `at about $${usd(econ.perRequestUsd)} per request on ${econ.from} against $${usd(econ.targetPerRequestUsd)} on Sonnet; `
      + `to keep the reasoning, run \`/compact keep the decisions, open tasks and reasoning for: ${focus}\` while still on Opus `
      + `(Opus writes the summary, and the re-cache drops from ~$${usd(econ.recacheUsd)} to ~$${usd(afterCompact ? afterCompact.recacheUsd : econ.recacheUsd)}), `
      + 'then `/model sonnet`. They will be told before the next job that needs Opus. '
      + 'The session model is theirs to change; do not switch it for them.';
    return { message, hold: null, state };
  }

  // Up to Opus. A prompt that itself needs Opus is held, once, before it runs on Sonnet.
  if (pred.fromPrompt && s.hold && (!prior || prior.heldPrompt !== clip(input.prompt, 200))) {
    return {
      message: null,
      hold: `[rcskills] This session is on Sonnet and this message needs Opus: ${pred.why}. `
        + 'Run `/model opus`, then send it again. The reasoning carries over. '
        + 'To run it on Sonnet anyway, just send it again.',
      state: { ...state, heldPrompt: clip(input.prompt, 200) },
    };
  }
  const message = `[router] Model: the next work needs Opus — ${pred.why}. Tell the user in one sentence, `
    + 'at the start of your reply, to run `/model opus` before the next message, and that the reasoning so far carries over. '
    + 'Do not switch it for them.';
  return { message, hold: null, state };
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
        if (pred.fromPrompt) out.held++;
      }
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
    `  switches:               ${r.down} down, ${r.up} up (${r.held} held before the work ran)`,
  ].join('\n');
}

module.exports = {
  adviseSessionSwitch,
  predictModel,
  readPrompt,
  switchEconomics,
  replaySwitchPolicy,
  formatReplay,
  TARGET,
  MEDIAN_TURN_REQUESTS,
  SMALL_RUN,
  WORK_ORDER,
};
