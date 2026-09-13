'use strict';

// Anthropic first-party list prices, USD per million tokens, from the claude-api
// reference (cached 2026-06-24). `cacheRead` is set only where it differs from the
// usual 0.1x input. Update when list prices change.
const PRICING = {
  'claude-fable-5-1': { in: 10, out: 50, cacheRead: 0.25 },
  'claude-fable-5': { in: 10, out: 50 },
  'claude-opus-5': { in: 5, out: 25 },
  'claude-opus-4-8': { in: 5, out: 25 },
  'claude-opus-4-7': { in: 5, out: 25 },
  'claude-opus-4-6': { in: 5, out: 25 },
  'claude-sonnet-5': { in: 2, out: 10 },
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 },
};

// Context windows in tokens; every priced model not listed here has 1M.
const WINDOW = { 'claude-haiku-4-5': 200000 };
const DEFAULT_WINDOW = 1000000;

const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2;

// Spinning up a subagent is not free: it re-reads the task, the files it needs
// and its own tool definitions, none of which inherit the parent's cache.
const DEFAULT_HANDOFF_TOKENS = 4000;

/** Transcripts sometimes record a dated id (claude-haiku-4-5-20251001); price by the base id. */
function normalizeModel(model) {
  return String(model || '').replace(/-\d{8}$/, '');
}

function rate(model) {
  return PRICING[normalizeModel(model)] || null;
}

function cacheReadRate(model) {
  const r = rate(model);
  if (!r) return null;
  return r.cacheRead ?? r.in * CACHE_READ_MULTIPLIER;
}

function contextWindow(model) {
  const id = normalizeModel(model);
  if (!PRICING[id]) return null;
  return WINDOW[id] || DEFAULT_WINDOW;
}

function priceOf(model, inTokens, outTokens, cachedTokens = 0) {
  const p = rate(model);
  if (!p) return null;
  const fresh = Math.max(0, inTokens - cachedTokens);
  const cached = Math.min(inTokens, Math.max(0, cachedTokens));
  const readRate = p.cacheRead ?? p.in * CACHE_READ_MULTIPLIER;
  return (
    (fresh / 1e6) * p.in +
    (cached / 1e6) * readRate +
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
  const subModel = opts.subModel || 'claude-haiku-4-5';
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
  cacheReadRate,
  contextWindow,
  normalizeModel,
  PRICING,
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_5M,
  CACHE_WRITE_1H,
  DEFAULT_HANDOFF_TOKENS,
};
