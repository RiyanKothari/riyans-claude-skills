'use strict';

// USD per million tokens. cacheRead is Anthropic's ~0.1x input rate; cache
// writes are ~1.25x but are paid once by the session, not per delegation.
const PRICING = {
  'claude-haiku-4-5-20251001': { in: 1, out: 5 },
  'claude-sonnet-5': { in: 3, out: 15 },
  'claude-opus-5': { in: 15, out: 75 },
};

const CACHE_READ_MULTIPLIER = 0.1;

// Spinning up a subagent is not free: it re-reads the task, the files it needs
// and its own tool definitions, none of which inherit the parent's cache.
const DEFAULT_HANDOFF_TOKENS = 4000;

function rate(model) {
  return PRICING[model] || null;
}

function priceOf(model, inTokens, outTokens, cachedTokens = 0) {
  const p = rate(model);
  if (!p) return null;
  const fresh = Math.max(0, inTokens - cachedTokens);
  const cached = Math.min(inTokens, Math.max(0, cachedTokens));
  return (
    (fresh / 1e6) * p.in +
    (cached / 1e6) * p.in * CACHE_READ_MULTIPLIER +
    (outTokens / 1e6) * p.out
  );
}

/**
 * Honest inline-vs-delegate comparison.
 *
 * Inline keeps the session model but pays cache rates on the warm prefix.
 * Delegation gets a cheaper model but pays full rate on a cold context.
 */
function compare(opts = {}) {
  const sessionModel = opts.sessionModel || 'claude-opus-5';
  const subModel = opts.subModel || 'claude-haiku-4-5-20251001';
  const contextTokens = opts.contextTokens ?? 15000;
  const cachedTokens = opts.cachedTokens ?? 0;
  const outTokens = opts.outTokens ?? 2000;
  const handoffTokens = opts.handoffTokens ?? DEFAULT_HANDOFF_TOKENS;
  const margin = opts.margin ?? 0.15;

  const inline = priceOf(sessionModel, contextTokens, outTokens, cachedTokens);
  const delegate = priceOf(subModel, handoffTokens, outTokens, 0);

  if (inline === null || delegate === null) {
    return { inline: null, delegate: null, winner: 'inline', savedUsd: 0, savedPct: 0 };
  }

  // Only claim a win when it clears the margin — a delegation that saves a
  // rounding error still costs a round trip and a context re-explanation.
  const worthIt = delegate < inline * (1 - margin);

  return {
    inline: Number(inline.toFixed(6)),
    delegate: Number(delegate.toFixed(6)),
    winner: worthIt ? 'delegate' : 'inline',
    savedUsd: worthIt ? Number((inline - delegate).toFixed(6)) : 0,
    savedPct: worthIt ? Number((((inline - delegate) / inline) * 100).toFixed(1)) : 0,
    cacheRatio: contextTokens ? Number((cachedTokens / contextTokens).toFixed(2)) : 0,
  };
}

module.exports = {
  compare,
  priceOf,
  rate,
  PRICING,
  CACHE_READ_MULTIPLIER,
  DEFAULT_HANDOFF_TOKENS,
};
