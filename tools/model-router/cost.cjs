'use strict';

// Anthropic first-party list prices, USD per million tokens, from
// platform.claude.com/docs/en/about-claude/pricing (checked 2026-09-17). `cacheRead`
// is set only where it differs from the usual 0.1x input. Update when prices change.
const PRICING = {
  'claude-fable-5-1': { in: 10, out: 50, cacheRead: 0.25 },
  'claude-mythos-5-1': { in: 10, out: 50, cacheRead: 0.25 },
  'claude-fable-5': { in: 10, out: 50 },
  'claude-mythos-5': { in: 10, out: 50 },
  'claude-opus-5': { in: 5, out: 25 },
  'claude-opus-4-8': { in: 5, out: 25 },
  'claude-opus-4-7': { in: 5, out: 25 },
  'claude-opus-4-6': { in: 5, out: 25 },
  'claude-opus-4-5': { in: 5, out: 25 },
  'claude-opus-4-1': { in: 15, out: 75 },
  'claude-opus-4': { in: 15, out: 75 },
  'claude-sonnet-5': { in: 2, out: 10 },
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-sonnet-4-5': { in: 3, out: 15 },
  'claude-sonnet-4': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 },
  'claude-haiku-3-5': { in: 0.8, out: 4 },
};

// Context windows in tokens. Claude 4.6 and later have 1M; earlier models 200k.
const WINDOW = {
  'claude-opus-4-5': 200000,
  'claude-opus-4-1': 200000,
  'claude-opus-4': 200000,
  'claude-sonnet-4-5': 200000,
  'claude-sonnet-4': 200000,
  'claude-haiku-4-5': 200000,
  'claude-haiku-3-5': 200000,
};
const DEFAULT_WINDOW = 1000000;

// A Claude model newer than this table is priced as its family's newest known
// model, so a release does not silently switch the cache guard off. Anything that
// is not recognisably Claude stays unpriced.
const FAMILY_FALLBACK = {
  fable: 'claude-fable-5-1',
  mythos: 'claude-mythos-5-1',
  opus: 'claude-opus-5',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5',
};

const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2;

// The brief the parent writes for a subagent: files, exact change, verify command.
// Sized above the real briefs measured in router.md. The parent pays for it once as
// output when it writes the Agent call, then again as input when it reads back.
const DEFAULT_HANDOFF_TOKENS = 600;

// The subagent's reply, which the parent reads back as fresh input. An assumption.
const RESULT_TOKENS = 300;

// Measured 2026-09-16 from three real haiku subagent transcripts: the first call
// already carried 55,674-55,856 tokens (system prompt, CLAUDE.md files, skill and
// agent listings) before the brief. Trimming the subagent's tool list moved it ~1%.
const SUBAGENT_BASE_TOKENS = 56000;

// A fresh session starts with about the same fixed context a subagent does.
const FRESH_SESSION_TOKENS = 56000;

// A mechanical edit is typically read + edit. Transcripts do not record final
// output reliably, so output per request is an assumption, not a measurement.
const DEFAULT_TASK_CALLS = 2;
const OUT_PER_REQUEST = 400;

/**
 * The base id a model is priced by. Transcripts and providers spell one model many
 * ways: dated (claude-haiku-4-5-20251001), Bedrock (us.anthropic.claude-sonnet-4-5-
 * 20250929-v1:0), Vertex (claude-sonnet-4-5@20250929), aliased (claude-opus-4-0),
 * with a context suffix (claude-sonnet-4-5[1m]) or in the legacy order (claude-3-5-haiku).
 */
function normalizeModel(model) {
  let id = String(model || '').trim().toLowerCase();
  id = id.replace(/\[[^\]]*\]$/, '');
  const at = id.lastIndexOf('claude-');
  if (at > 0) id = id.slice(at);
  id = id.replace(/@.*$/, '').replace(/-v\d+(:\d+)?$/, '').replace(/-\d{8}$/, '');
  id = id.replace(/^claude-(\d+)-(\d+)-(opus|sonnet|haiku)$/, 'claude-$3-$1-$2');
  id = id.replace(/^claude-(\d+)-(opus|sonnet|haiku)$/, 'claude-$2-$1');
  return id.replace(/^(claude-[a-z]+-\d+)-0$/, '$1');
}

/** The table entry a model is priced by: its own, else its family's newest. */
function pricedId(model) {
  const id = normalizeModel(model);
  if (PRICING[id]) return id;
  const family = /^claude-([a-z]+)-\d/.exec(id);
  return family && FAMILY_FALLBACK[family[1]] ? FAMILY_FALLBACK[family[1]] : null;
}

function rate(model) {
  const id = pricedId(model);
  return id ? PRICING[id] : null;
}

function cacheReadRate(model) {
  const r = rate(model);
  if (!r) return null;
  return r.cacheRead ?? r.in * CACHE_READ_MULTIPLIER;
}

function contextWindow(model) {
  const id = pricedId(model);
  if (!id) return null;
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
 * One subagent run: the first call writes its fixed prefix to cache (or reads it,
 * when a recent run left it warm) and every later call reads it back.
 *
 * @param {string} model
 * @param {number} calls
 * @param {{warm?: boolean, handoffTokens?: number, outPerRequest?: number}} [opts]
 */
function subagentCost(model, calls, opts = {}) {
  const p = rate(model);
  if (!p) return null;
  const context = SUBAGENT_BASE_TOKENS + (opts.handoffTokens ?? DEFAULT_HANDOFF_TOKENS);
  const out = opts.outPerRequest ?? OUT_PER_REQUEST;
  const readRate = p.cacheRead ?? p.in * CACHE_READ_MULTIPLIER;
  const first = opts.warm ? context * readRate : context * p.in * CACHE_WRITE_5M;
  return (first + Math.max(0, calls - 1) * context * readRate + calls * out * p.out) / 1e6;
}

/**
 * Inline versus delegate, priced against the session the work is really in.
 *
 * Inline: the task's tool calls plus a reply, each re-reading the session's cached
 * context on the session model. Delegate: two parent requests plus a subagent run.
 * The subagent's fixed prefix is why a fresh session never repays delegation while
 * a long one can. The old model priced a 4k handoff against a 15k context and
 * claimed ~89% for every session.
 */
function compare(opts = {}) {
  const sessionModel = opts.sessionModel || 'claude-opus-5';
  const subModel = opts.subModel || 'claude-haiku-4-5';
  const contextTokens = opts.contextTokens ?? FRESH_SESSION_TOKENS;
  const taskCalls = opts.taskCalls ?? DEFAULT_TASK_CALLS;
  const handoffTokens = opts.handoffTokens ?? DEFAULT_HANDOFF_TOKENS;
  const out = opts.outPerRequest ?? OUT_PER_REQUEST;
  const margin = opts.margin ?? 0.15;
  const warm = Boolean(opts.warmSubagent);

  const price = (ctx) => {
    const one = priceOf(sessionModel, ctx, out, ctx);
    // The parent's two requests, each re-reading the session: one writes the brief
    // (output), one reads the brief and the subagent's result back as fresh input.
    const issue = priceOf(sessionModel, ctx, handoffTokens, ctx);
    const collect = priceOf(sessionModel, ctx + handoffTokens + RESULT_TOKENS, out, ctx);
    const sub = subagentCost(subModel, taskCalls + 1, { warm, handoffTokens, outPerRequest: out });
    if (one === null || issue === null || collect === null || sub === null) return null;
    return { inline: (taskCalls + 1) * one, delegate: issue + collect + sub };
  };
  // Only a win that clears the margin counts: a rounding-error saving still costs a round trip.
  const pays = (c) => c.delegate < c.inline * (1 - margin);

  const at = price(contextTokens);
  if (!at) {
    return { inline: null, delegate: null, winner: 'inline', savedUsd: 0, savedPct: 0, contextTokens, breakEvenTokens: null };
  }
  const worthIt = pays(at);

  // The smallest session context at which delegation clears the margin, so the
  // router can say why it stayed silent. null: it never does below 1M tokens.
  let breakEvenTokens = null;
  const top = price(DEFAULT_WINDOW);
  if (top && pays(top)) {
    let lo = 0;
    let hi = DEFAULT_WINDOW;
    while (hi - lo > 1000) {
      const mid = Math.floor((lo + hi) / 2);
      const pm = price(mid);
      if (pm && pays(pm)) hi = mid;
      else lo = mid;
    }
    breakEvenTokens = hi;
  }

  return {
    inline: Number(at.inline.toFixed(6)),
    delegate: Number(at.delegate.toFixed(6)),
    winner: worthIt ? 'delegate' : 'inline',
    savedUsd: worthIt ? Number((at.inline - at.delegate).toFixed(6)) : 0,
    savedPct: worthIt ? Number((((at.inline - at.delegate) / at.inline) * 100).toFixed(1)) : 0,
    contextTokens,
    breakEvenTokens,
  };
}

module.exports = {
  compare,
  priceOf,
  subagentCost,
  rate,
  cacheReadRate,
  contextWindow,
  normalizeModel,
  pricedId,
  PRICING,
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_5M,
  CACHE_WRITE_1H,
  DEFAULT_HANDOFF_TOKENS,
  SUBAGENT_BASE_TOKENS,
  FRESH_SESSION_TOKENS,
  RESULT_TOKENS,
  DEFAULT_TASK_CALLS,
  OUT_PER_REQUEST,
};
