'use strict';

/**
 * Carries a session's working state across a model switch.
 *
 * The conversation survives a switch, but reasoning does not: thinking blocks are
 * signed by the model that wrote them, so the next model cannot use them. In real
 * transcripts 480 of 3,453 thinking blocks held readable text (avg 327 chars) — the
 * rest were signature-only. So the handoff keeps what can be kept as plain text:
 * the latest readable reasoning, the open tasks, the files in flight and the asks.
 * It is written when the model changes and shown once, on the next prompt.
 */

/** Stale after this long: a switch that was cancelled should not echo into next week. */
const MAX_AGE_MS = 2 * 60 * 60 * 1000;
/** About 450 tokens. The handoff is paid once; it must still be small. */
const BUDGET_CHARS = 1800;

const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * @param {{prompts?: string[], files?: string[], lastText?: string, thinking?: string[], todos?: string[]}|null} handoff
 * @param {{sessionId?: string|null, from?: string|null, to?: string|null, now?: number}} meta
 */
function captureSwitch(handoff, meta = {}) {
  if (!handoff) return null;
  const record = {
    sessionId: meta.sessionId || null,
    from: meta.from || null,
    to: meta.to || null,
    at: meta.now || Date.now(),
    asks: (handoff.prompts || []).slice(-2).map((p) => clip(p, 200)),
    reasoning: (handoff.thinking || []).slice(-2).map((t) => clip(t, 500)),
    todos: (handoff.todos || []).slice(0, 6).map((t) => clip(t, 120)),
    files: (handoff.files || []).slice(0, 8).map((f) => String(f).replace(/\\/g, '/').split('/').slice(-2).join('/')),
    lastText: clip(handoff.lastText, 400),
    shown: false,
  };
  const empty = !record.asks.length && !record.reasoning.length && !record.todos.length && !record.lastText;
  return empty ? null : record;
}

/**
 * The line to show on the first prompt after a switch, or null when there is none
 * for this session, it was already shown, or it is too old to trust.
 *
 * @param {object|null} record
 * @param {{sessionId?: string|null, now?: number}} ctx
 */
function handoffLine(record, ctx = {}) {
  if (!record || record.shown) return null;
  if ((record.sessionId || null) !== (ctx.sessionId || null)) return null;
  if ((ctx.now || Date.now()) - Number(record.at || 0) > MAX_AGE_MS) return null;

  const parts = [];
  if (record.reasoning.length) parts.push(`reasoning so far: ${record.reasoning.map((r) => `"${r}"`).join(' / ')}`);
  if (record.todos.length) parts.push(`open tasks: ${record.todos.join('; ')}`);
  if (record.asks.length) parts.push(`working on: ${record.asks.map((a) => `"${a}"`).join(', ')}`);
  if (record.files.length) parts.push(`files in flight: ${record.files.join(', ')}`);
  if (record.lastText) parts.push(`last reply: "${record.lastText}"`);
  if (!parts.length) return null;

  const head = `[handoff] The model changed${record.from ? ` from ${record.from}` : ''}${record.to ? ` to ${record.to}` : ''}; `
    + 'its reasoning does not carry over by itself, so here it is as text. Continue from it; do not redo settled work. ';
  let body = parts.join(' | ');
  if (head.length + body.length > BUDGET_CHARS) body = `${body.slice(0, BUDGET_CHARS - head.length - 1)}…`;
  return head + body;
}

module.exports = { captureSwitch, handoffLine, MAX_AGE_MS, BUDGET_CHARS };
