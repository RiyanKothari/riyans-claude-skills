'use strict';

const { DEFAULTS } = require('./config.cjs');

const DEFAULT_SETTINGS = DEFAULTS.compact;

/**
 * Decide whether this message should carry a compaction prompt, and what to
 * remember about having given one. Pure — the hook does the reading and writing.
 *
 * Prompts once context crosses the threshold, then again only after it grows by
 * `remindEvery`. A new session, or a context that has shrunk because the user
 * compacted, starts the count again.
 *
 * @param {{
 *   tokens: number,
 *   sessionId?: string|null,
 *   state?: {sessionId?: string|null, advisedAt?: number}|null,
 *   settings?: {enabled?: boolean, threshold?: number, remindEvery?: number},
 *   costPerRequestUsd?: number|null,
 *   rewriteUsd?: number|null,
 * }} input
 */
function adviseCompact(input) {
  const tokens = Number(input.tokens || 0);
  const sessionId = input.sessionId || null;
  const s = { ...DEFAULT_SETTINGS, ...(input.settings || {}) };
  const prev = input.state || null;

  let advisedAt = prev && (prev.sessionId || null) === sessionId ? Number(prev.advisedAt || 0) : 0;
  if (advisedAt && tokens < advisedAt) advisedAt = 0;

  const quiet = { message: null, state: { sessionId, advisedAt } };
  if (!s.enabled || !tokens || tokens < s.threshold) return quiet;
  if (advisedAt && tokens - advisedAt < s.remindEvery) return quiet;

  const costs = [];
  if (input.costPerRequestUsd) costs.push(`~$${input.costPerRequestUsd.toFixed(2)} per request to re-read`);
  if (input.rewriteUsd) costs.push(`~$${input.rewriteUsd.toFixed(2)} to rewrite an expired cache`);
  const cost = costs.length ? ` (${costs.join(', ')})` : '';

  return {
    message:
      `[context] ${Math.round(tokens / 1000)}k tokens in this session${cost}. ` +
      'Tell the user in one sentence and suggest /compact at the next phase boundary — never ' +
      'mid-implementation — naming what to keep, e.g. "/compact keep the open gaps and decisions". ' +
      'Save anything important to memory first.',
    state: { sessionId, advisedAt: tokens },
  };
}

module.exports = { adviseCompact, DEFAULT_SETTINGS };
