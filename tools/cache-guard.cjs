'use strict';

const { FRESH_SESSION_TOKENS, rate, normalizeModel } = require('./model-router/cost.cjs');

/**
 * The cold-cache guard. Measured on 2,778 real requests: 60 mid-session cache
 * rewrites cost $179, 21% of all spend, and 48 of them followed an idle gap. A
 * message sent after the prompt cache expires re-caches the whole context at the
 * cache-write rate (2x input on a 1-hour cache) before any work happens.
 *
 * So the first message after expiry is held back once, with the price. The user
 * can /clear (a fresh session costs a fraction, and is handed a summary of this
 * one) or send it again to continue. Pure — the hook does the reading and writing.
 *
 * @param {{
 *   prompt: string,
 *   tokens: number,
 *   model?: string|null,
 *   lastResponseAt?: number,
 *   cacheTtl?: '1h'|'5m'|null,
 *   now?: number,
 *   sessionId?: string|null,
 *   state?: {sessionId?: string|null, lastResponseAt?: number}|null,
 *   settings?: {enabled?: boolean, budgetUsd?: number},
 * }} input
 * @returns {{block: string|null, rewriteUsd: number, freshUsd: number, state: object|null}}
 */
function adviseColdCache(input) {
  const settings = { enabled: true, budgetUsd: 0.5, ...(input.settings || {}) };
  const quiet = (rewriteUsd = 0, freshUsd = 0) => ({ block: null, rewriteUsd, freshUsd, state: null });
  const tokens = Number(input.tokens || 0);
  const lastAt = Number(input.lastResponseAt || 0);
  const prompt = String(input.prompt || '').trim();

  // Slash commands (/clear, /compact) are the way out; never stand in front of them.
  if (!settings.enabled || !tokens || !lastAt || !prompt || prompt.startsWith('/')) return quiet();

  // Claude Code caches the main thread for an hour unless a request says otherwise.
  const oneHour = input.cacheTtl !== '5m';
  const ttlMs = oneHour ? 3600000 : 300000;
  const idleMs = (input.now ?? Date.now()) - lastAt;
  if (idleMs < ttlMs) return quiet();

  const p = rate(input.model);
  if (!p) return quiet();
  const writeRate = p.in * (oneHour ? 2 : 1.25);
  const rewriteUsd = (tokens * writeRate) / 1e6;
  const freshUsd = (FRESH_SESSION_TOKENS * writeRate) / 1e6;
  if (rewriteUsd - freshUsd < settings.budgetUsd) return quiet(rewriteUsd, freshUsd);

  // Once per idle period: sending again means the user chose to continue here.
  const prev = input.state;
  if (prev && prev.sessionId === (input.sessionId || null) && prev.lastResponseAt === lastAt) {
    return quiet(rewriteUsd, freshUsd);
  }

  const hours = Math.floor(idleMs / 3600000);
  const minutes = Math.round((idleMs % 3600000) / 60000);
  const idle = hours ? `${hours}h ${minutes}m` : `${minutes}m`;
  return {
    block:
      `[cache] Not sent: this session's ${oneHour ? '1-hour' : '5-minute'} prompt cache expired ${idle} ago, so ` +
      `this message would first re-cache ${Math.round(tokens / 1000)}k tokens on ${normalizeModel(input.model)} ` +
      `(~$${rewriteUsd.toFixed(2)}). /clear starts fresh for ~$${freshUsd.toFixed(2)} and hands the new session ` +
      'a summary of this one. Send the message again to continue here anyway. ' +
      '(rcskills config cache-guard off|<usd> changes this.)',
    rewriteUsd,
    freshUsd,
    state: { sessionId: input.sessionId || null, lastResponseAt: lastAt },
  };
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

module.exports = { adviseColdCache, handoffSummary };
