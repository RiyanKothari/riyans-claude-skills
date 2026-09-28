'use strict';

/**
 * The one line per reply that tells the user which slash command to run next.
 *
 * Hooks cannot run /compact or /model — only the user can — so the line has to reach
 * them every time it matters. It is written here, finished, and Claude copies it:
 * an instruction to "suggest /compact at the next phase boundary" cost ~86 tokens in,
 * a composed sentence out, and could be judged unnecessary and dropped. A finished
 * line costs about half going in and is copied, not reasoned about.
 */

const TAG = '[next]';

const k = (n) => `${Math.round(Number(n) / 1000)}k`;
const usd = (n) => `$${Number(n).toFixed(2)}`;
const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').replace(/"/g, "'").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** What `/compact keep …` should name: the work in hand, so the summary keeps it. */
function compactCommand(focus) {
  const f = clip(focus, 48);
  return f ? `/compact keep decisions and open tasks for "${f}"` : '/compact keep decisions and open tasks';
}

/** The directive Claude sees: copy this finished line as the last line of the reply. */
function relay(line) {
  return line ? `${TAG} End your reply with exactly this line: "${line}"` : null;
}

/** @param {{tokens: number, perRequestUsd?: number|null, focus?: string|null}} a */
function compactLine({ tokens, perRequestUsd, focus }) {
  const cost = perRequestUsd ? `, ${usd(perRequestUsd)} per message to re-read` : '';
  return `Next: ${compactCommand(focus)} — ${k(tokens)} of context${cost}.`;
}

/** @param {{focus?: string|null, from: string, to: string, fromUsd: number, toUsd: number}} a */
function modelSwitchLine({ focus, from, to, fromUsd, toUsd }) {
  return `Next: ${compactCommand(focus)}, then /model ${to} — newer and cheaper than ${from}; `
    + `${usd(toUsd)} vs ${usd(fromUsd)} per message.`;
}

/** Why the last message paid to re-send its context, and what avoids it next time. */
/** @param {{tokens: number, usd: number, reason: string, fix: string}} a */
function rewriteLine({ tokens, usd: cost, reason, fix }) {
  return `The last message re-sent ${k(tokens)} cached tokens (~${usd(cost)}) because ${reason}. Next time: ${fix}.`;
}

/** Before stepping away from a large session: how long the cache stays cheap. */
/** @param {{tokens: number, window: string, rewriteUsd: number, freshUsd: number}} a */
function stayCheapLine({ tokens, window, rewriteUsd, freshUsd }) {
  return `Next: reply within ${window} to keep ${k(tokens)} cached, or /compact before stepping away `
    + `(later: ~${usd(rewriteUsd)} to re-send; /clear ~${usd(freshUsd)}).`;
}

const PREFIX = `${TAG} End your reply with exactly this line: "`;

/**
 * At most one command line per reply: every [next] directive the hooks produced for
 * this message becomes one, in order, after everything else. Two relayed lines cost
 * twice the output and read as nagging.
 *
 * @param {string[]} lines
 */
function mergeNext(lines) {
  const rest = [];
  const said = [];
  for (const l of lines) {
    if (typeof l === 'string' && l.startsWith(PREFIX) && l.endsWith('"')) said.push(l.slice(PREFIX.length, -1));
    else rest.push(l);
  }
  return said.length ? [...rest, relay(said.join(' '))] : rest;
}

module.exports = {
  TAG, relay, mergeNext, compactCommand, compactLine, modelSwitchLine, rewriteLine, stayCheapLine,
};
