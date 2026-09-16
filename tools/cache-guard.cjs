'use strict';

const { FRESH_SESSION_TOKENS, rate, normalizeModel } = require('./model-router/cost.cjs');

/**
 * Keeps sessions from paying to re-cache context they already had cached.
 *
 * Measured on 2,821 real requests: rewrites of already-cached context cost $168,
 * 20% of all spend. Across ~2,700 consecutive request pairs the causes were: the
 * cache expiring while idle (39), idle gaps of 30-60 minutes on a nominal 1-hour
 * cache (2 of 10 such gaps rewrote, against 1 of 70 gaps of 5-30 minutes), a
 * `/model` command re-selecting the model already in use (1 of 1), and two misses
 * with no local cause.
 *
 * So Claude Code is told nothing (zero tokens); the user is told, after a reply,
 * when the cache stops being reliable and what returning later will cost. Pure —
 * the hook does the reading and writing.
 */

const TTL_MS = { '1h': 3600000, '5m': 300000 };
// A 1-hour cache is only dependable for about half of its nominal life.
const RELIABLE_1H_MS = 30 * 60000;
const NOTICE_EVERY_MS = 15 * 60000;
const NOTICE_GROWTH_TOKENS = 100000;

const DEFAULTS = { enabled: true, budgetUsd: 0.5, mode: 'notify' };
const k = (n) => `${Math.round(n / 1000)}k`;

/** What re-caching this context costs, against starting a fresh session. */
function price(tokens, model, cacheTtl) {
  const p = rate(model);
  if (!p || !tokens) return null;
  const oneHour = cacheTtl !== '5m';
  const writeRate = p.in * (oneHour ? 2 : 1.25);
  return {
    oneHour,
    rewriteUsd: (tokens * writeRate) / 1e6,
    freshUsd: (FRESH_SESSION_TOKENS * writeRate) / 1e6,
  };
}

/**
 * Block mode only (`rcskills config cache-guard block`): holds the first message
 * after the cache expires, once, with the price. Sending it again goes through.
 *
 * @param {{
 *   prompt: string, tokens: number, model?: string|null, lastResponseAt?: number,
 *   cacheTtl?: '1h'|'5m'|null, now?: number, sessionId?: string|null,
 *   state?: {sessionId?: string|null, lastResponseAt?: number}|null,
 *   settings?: {enabled?: boolean, budgetUsd?: number, mode?: string},
 * }} input
 */
function adviseColdCache(input) {
  const s = { ...DEFAULTS, ...(input.settings || {}) };
  const quiet = { block: null, state: null };
  const lastAt = Number(input.lastResponseAt || 0);
  const prompt = String(input.prompt || '').trim();
  // Slash commands (/clear, /compact) are the way out; never stand in front of them.
  if (!s.enabled || s.mode !== 'block' || !lastAt || !prompt || prompt.startsWith('/')) return quiet;

  const pr = price(Number(input.tokens || 0), input.model, input.cacheTtl);
  if (!pr || pr.rewriteUsd - pr.freshUsd < s.budgetUsd) return quiet;
  const idleMs = (input.now ?? Date.now()) - lastAt;
  if (idleMs < TTL_MS[pr.oneHour ? '1h' : '5m']) return quiet;

  const prev = input.state;
  if (prev && prev.sessionId === (input.sessionId || null) && prev.lastResponseAt === lastAt) return quiet;

  const hours = Math.floor(idleMs / 3600000);
  const minutes = Math.round((idleMs % 3600000) / 60000);
  return {
    block:
      `[cache] Not sent: this session's ${pr.oneHour ? '1-hour' : '5-minute'} prompt cache expired ` +
      `${hours ? `${hours}h ${minutes}m` : `${minutes}m`} ago, so this message would first re-cache ` +
      `${k(input.tokens)} tokens on ${normalizeModel(input.model)} (~$${pr.rewriteUsd.toFixed(2)}). /clear starts ` +
      `fresh for ~$${pr.freshUsd.toFixed(2)} with a summary of this session. Send the message again to continue here.`,
    state: { sessionId: input.sessionId || null, lastResponseAt: lastAt },
  };
}

/**
 * After a reply in a session large enough that returning late is expensive: until
 * when the cache is dependable, and what to do before stepping away. Shown to the
 * user only, so it costs no tokens. Repeats at most every 15 minutes unless the
 * context has grown by 100k.
 *
 * @param {{
 *   tokens: number, model?: string|null, cacheTtl?: '1h'|'5m'|null, now?: number,
 *   sessionId?: string|null, state?: {sessionId?: string|null, at?: number, tokens?: number}|null,
 *   settings?: {enabled?: boolean, budgetUsd?: number},
 * }} input
 */
function afterReplyNotice(input) {
  const s = { ...DEFAULTS, ...(input.settings || {}) };
  const tokens = Number(input.tokens || 0);
  const now = input.now ?? Date.now();
  const quiet = { message: null, state: input.state || null };
  if (!s.enabled) return quiet;

  const pr = price(tokens, input.model, input.cacheTtl);
  if (!pr || pr.rewriteUsd - pr.freshUsd < s.budgetUsd) return quiet;

  const prev = input.state;
  if (prev && prev.sessionId === (input.sessionId || null)
    && now - Number(prev.at || 0) < NOTICE_EVERY_MS
    && tokens - Number(prev.tokens || 0) < NOTICE_GROWTH_TOKENS) return quiet;

  const until = new Date(now + (pr.oneHour ? RELIABLE_1H_MS : TTL_MS['5m'])).toTimeString().slice(0, 5);
  return {
    message:
      `[cache] ${k(tokens)} tokens cached. Reply before ${until} to keep it cheap; after that your next ` +
      `message can re-send it all for ~$${pr.rewriteUsd.toFixed(2)}. Stepping away? Run /compact first, or ` +
      `/clear (~$${pr.freshUsd.toFixed(2)} to restart, with a summary of this session).`,
    state: { sessionId: input.sessionId || null, at: now, tokens },
  };
}

/**
 * PreModelSwitch. Re-selecting the model already in use changes nothing but still
 * re-caches the whole context (measured: 347k tokens rewritten), so it asks first.
 * Real switches are left to Claude Code, which already confirms cache-missing ones.
 *
 * @param {{from_model?: string, to_model?: string, prompt_cache_warm?: boolean,
 *   context_tokens?: number, estimated_cache_write_usd?: number}} input
 */
function adviseModelSwitch(input) {
  const from = normalizeModel(input.from_model);
  const to = normalizeModel(input.to_model);
  const tokens = Number(input.context_tokens || 0);
  if (!from || from !== to || input.prompt_cache_warm === false || !tokens) return null;
  const usd = Number(input.estimated_cache_write_usd) || (price(tokens, to, '1h') || { rewriteUsd: 0 }).rewriteUsd;
  return `[cache] Already on ${to}: this changes nothing but re-caches ${k(tokens)} tokens ` +
    `(~$${usd.toFixed(2)}). Confirm only if you meant to change something else.`;
}

/** A short summary a fresh session can pick up from, built from the transcript alone. */
function handoffSummary(handoff) {
  if (!handoff) return null;
  const clip = (s, n) => {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
  };
  const parts = [];
  if (handoff.prompts && handoff.prompts.length) {
    parts.push(`recent asks: ${handoff.prompts.map((p) => `"${clip(p, 140)}"`).join(', ')}`);
  }
  if (handoff.files && handoff.files.length) {
    const shown = handoff.files.slice(0, 8).map((f) => String(f).replace(/\\/g, '/').split('/').slice(-2).join('/'));
    parts.push(`files edited: ${shown.join(', ')}${handoff.files.length > 8 ? ` +${handoff.files.length - 8}` : ''}`);
  }
  if (handoff.lastText) parts.push(`last reply: "${clip(handoff.lastText, 500)}"`);
  return parts.length ? parts.join('; ') : null;
}

module.exports = {
  adviseColdCache, afterReplyNotice, adviseModelSwitch, handoffSummary, price,
  RELIABLE_1H_MS, DEFAULTS,
};
