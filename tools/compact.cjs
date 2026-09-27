'use strict';

const { DEFAULTS } = require('./config.cjs');
const { relay, compactLine } = require('./next-command.cjs');

const DEFAULT_SETTINGS = DEFAULTS.compact;
const k = (n) => `${Math.round(n / 1000)}k`;

function costModule() {
  try {
    return require('./model-router/cost.cjs');
  } catch {
    return null;
  }
}

/**
 * The context size at which this session should be prompted.
 *
 * Dynamic mode takes the lower of two limits — the point where re-reading the
 * context costs `budgetUsd` per request on this model, and `qualityShare` of the
 * model's context window — then brings it forward at a natural break or when
 * context is growing fast, and pushes it back mid-task. Fixed mode skips all of it.
 *
 * @param {{
 *   tokens: number,
 *   model?: string|null,
 *   phase?: string|null,
 *   growthPerPrompt?: number,
 *   settings?: object,
 * }} input
 */
function computeThreshold(input) {
  const s = { ...DEFAULT_SETTINGS, ...(input.settings || {}) };
  if (s.mode === 'fixed') return { threshold: s.threshold, reasons: ['fixed threshold'] };

  const cost = costModule();
  const knownWindow = cost ? cost.contextWindow(input.model) : null;
  const window = knownWindow || (input.tokens > 200000 ? 1000000 : 200000);
  const readPerM = cost ? cost.cacheReadRate(input.model) : null;
  const reasons = [];

  const byQuality = window * s.qualityShare;
  const byCost = readPerM ? (s.budgetUsd / readPerM) * 1e6 : Infinity;
  let base;
  if (byCost < byQuality) {
    base = byCost;
    reasons.push(`$${s.budgetUsd}/request on ${cost ? cost.normalizeModel(input.model) : input.model}`);
  } else {
    base = byQuality;
    const presumed = knownWindow ? '' : 'presumed ';
    reasons.push(`${Math.round(s.qualityShare * 100)}% of a ${presumed}${k(window)} window`);
  }

  let factor = 1;
  if (input.phase === 'boundary') {
    factor *= 0.75;
    reasons.push('at a natural break');
  } else if (input.phase === 'working') {
    factor *= 1.5;
    reasons.push('mid-task, so later');
  }

  const growth = Number(input.growthPerPrompt || 0);
  if (growth >= 50000) {
    factor *= 0.8;
    reasons.push('growing fast');
  } else if (growth > 0 && growth <= 10000) {
    factor *= 1.15;
    reasons.push('growing slowly');
  }

  const floor = Math.min(60000, window * 0.3);
  const ceiling = window * 0.8;
  return { threshold: Math.round(Math.min(ceiling, Math.max(floor, base * factor))), reasons };
}

/**
 * Decide whether this message should carry a compaction prompt, and what to
 * remember about the session. Pure — the hook does the reading and writing.
 *
 * Prompts once context crosses the session's prompt point, then again only after
 * it grows by `remindEvery`. A new session, or a context that has shrunk because
 * the user compacted, starts the count and the growth history again.
 *
 * @param {{
 *   tokens: number,
 *   sessionId?: string|null,
 *   state?: {sessionId?: string|null, advisedAt?: number, samples?: number[]}|null,
 *   settings?: object,
 *   model?: string|null,
 *   phase?: string|null,
 *   costPerRequestUsd?: number|null,
 *   rewriteUsd?: number|null,
 *   focus?: string|null,
 * }} input
 */
function adviseCompact(input) {
  const tokens = Number(input.tokens || 0);
  const sessionId = input.sessionId || null;
  const s = { ...DEFAULT_SETTINGS, ...(input.settings || {}) };
  const prev = input.state || null;
  const same = prev ? (prev.sessionId || null) === sessionId : false;

  let advisedAt = same && prev ? Number(prev.advisedAt || 0) : 0;
  const prevSamples = same && prev && Array.isArray(prev.samples) ? prev.samples : [];
  const last = prevSamples[prevSamples.length - 1];
  const compacted = (advisedAt > 0 && tokens < advisedAt) || (typeof last === 'number' && tokens < last);
  if (compacted) advisedAt = 0;

  const samples = tokens ? [...(compacted ? [] : prevSamples), tokens].slice(-6) : prevSamples;
  const growthPerPrompt = samples.length >= 2
    ? (samples[samples.length - 1] - samples[0]) / (samples.length - 1)
    : 0;

  const { threshold, reasons } = computeThreshold({
    tokens, model: input.model, phase: input.phase, growthPerPrompt, settings: s,
  });

  const quiet = { message: null, threshold, state: { sessionId, advisedAt, samples } };
  if (!s.enabled || !tokens || tokens < threshold) return quiet;
  if (advisedAt && tokens - advisedAt < s.remindEvery) return quiet;

  const cost = costModule();
  const readPerM = cost ? cost.cacheReadRate(input.model) : null;
  const perRequest = input.costPerRequestUsd ?? (readPerM ? (tokens / 1e6) * readPerM : null);

  // A finished line, relayed every time this fires: the user runs /compact, so the
  // user has to see it. Why the prompt point is where it is stays in `reasons` for
  // anyone debugging it, rather than being paid for in every session.
  return {
    message: relay(compactLine({ tokens, perRequestUsd: perRequest, focus: input.focus })),
    threshold,
    reasons,
    state: { sessionId, advisedAt: tokens, samples },
  };
}

module.exports = { adviseCompact, computeThreshold, DEFAULT_SETTINGS };
