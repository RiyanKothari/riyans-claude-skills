'use strict';

/**
 * The session ledger: what a session asked for, decided, left open and touched.
 *
 * /compact replaces the conversation with a summary, and no hook can write into that
 * summary. So the ledger is taken from the full transcript just before (PreCompact),
 * shown again right after (SessionStart, source "compact") and at the start of the
 * next session, and its decisions and open tasks go into the memory store, where
 * per-prompt recall finds them in any later session the work comes back to.
 *
 * Built from facts, not from prose: decisions are commit subjects (a commit is a
 * decision someone acted on), open tasks are the last TodoWrite list, files are the
 * ones edited. Bounded, so it can never cost more than a few hundred tokens.
 */

const fs = require('fs');
const { isHumanPrompt, isSystemText } = require('./outcome/transcript.cjs');

const MAX = { asks: 6, decisions: 8, open: 8, files: 12 };
const BUDGET_CHARS = 1600;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** Keep the last `n` distinct values, in order of last appearance. */
function lastDistinct(list, n) {
  const out = [];
  for (let i = list.length - 1; i >= 0 && out.length < n; i--) {
    if (!out.includes(list[i])) out.unshift(list[i]);
  }
  return out;
}

/**
 * The subject line of a `git commit -m "…"` or heredoc commit, or null.
 * @param {string|undefined} command
 */
function commitSubject(command) {
  const cmd = String(command || '');
  // A real `git commit` command — not a test or script that merely mentions commit.
  const at = cmd.search(/(?:^|[;&|(]\s*|\n\s*)git(?:\s+-C\s+\S+|\s+-c\s+\S+)*\s+commit\b/);
  if (at < 0) return null;
  const rest = cmd.slice(at);
  const quoted = rest.match(/\bcommit\b[^\n]*?\s-[a-zA-Z]*m\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/);
  const heredoc = /\bcommit\b[^\n]*-[a-zA-Z]*m\s+"\$\(cat\s+<</.test(rest) ? rest.match(/<<-?\s*'?(\w+)'?\s*\n([^\n]+)/) : null;
  // A heredoc message is also inside -m "…", so it is checked first.
  const raw = heredoc ? heredoc[2] : quoted ? (quoted[1] !== undefined ? quoted[1].replace(/\\(.)/g, '$1') : quoted[2]) : null;
  const subject = raw ? raw.split('\n')[0].trim() : '';
  return subject && !subject.startsWith('$(') ? subject : null;
}

/**
 * @param {string} filePath a session transcript (.jsonl)
 * @returns {{asks: string[], decisions: string[], open: string[], files: string[]}}
 */
function buildLedger(filePath) {
  /** @type {string[]} */ const asks = [];
  /** @type {string[]} */ const decisions = [];
  /** @type {string[]} */ const files = [];
  /** @type {Array<{content?: string, status?: string}>|null} */ let todos = null;
  let text = '';
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { asks: [], decisions: [], open: [], files: [] };
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (isHumanPrompt(o)) {
      const ask = o.message.content.trim();
      if (!ask.startsWith('/') && !isSystemText(ask)) asks.push(clip(ask, 140));
      continue;
    }
    const content = o.type === 'assistant' && o.message && Array.isArray(o.message.content) ? o.message.content : [];
    for (const b of content) {
      if (!b || b.type !== 'tool_use' || !b.input) continue;
      if (b.name === 'Bash' || b.name === 'PowerShell') {
        const subject = commitSubject(b.input.command);
        if (subject) decisions.push(clip(subject, 160));
      } else if (EDIT_TOOLS.has(b.name) && (b.input.file_path || b.input.notebook_path)) {
        const f = String(b.input.file_path || b.input.notebook_path).replace(/\\/g, '/');
        // Scratch and temp files are working notes, not the project's work.
        if (!/\/(?:scratchpad|Temp|tmp)\//i.test(f)) files.push(f);
      } else if (b.name === 'TodoWrite' && Array.isArray(b.input.todos)) {
        todos = b.input.todos;
      }
    }
  }
  const open = (todos || []).filter((t) => t && t.status !== 'completed' && t.content).map((t) => clip(t.content, 120));
  return {
    asks: lastDistinct(asks, MAX.asks),
    decisions: lastDistinct(decisions, MAX.decisions),
    open: open.slice(0, MAX.open),
    files: lastDistinct(files, MAX.files).map((f) => f.split('/').slice(-2).join('/')),
  };
}

const empty = (l) => !l || (!l.asks.length && !l.decisions.length && !l.open.length && !l.files.length);

/**
 * One bounded block of context. `lead` says where it came from.
 * @param {{asks: string[], decisions: string[], open: string[], files: string[]}} l
 * @param {string} lead
 */
function formatLedger(l, lead) {
  if (empty(l)) return null;
  const parts = [lead];
  if (l.decisions.length) parts.push(`decided and committed: ${l.decisions.join(' · ')}`);
  if (l.open.length) parts.push(`still open: ${l.open.join(' · ')}`);
  if (l.asks.length) parts.push(`recent asks: ${l.asks.map((a) => `"${a}"`).join(' · ')}`);
  if (l.files.length) parts.push(`files edited: ${l.files.join(', ')}`);
  parts.push('Continue from this; do not redo decided work.');
  let out = parts.join('. ').replace(/\.\./g, '.');
  if (out.length > BUDGET_CHARS) out = `${out.slice(0, BUDGET_CHARS - 1)}…`;
  return out;
}

/**
 * Put the decisions and open tasks where future sessions look: the memory store,
 * recalled per prompt by relevance. Exact repeats only refresh the existing record.
 * @param {{add: (r: object) => any}} store
 * @param {{decisions: string[], open: string[]}} l
 */
function persistLedger(store, l) {
  let n = 0;
  for (const d of l.decisions) {
    store.add({ kind: 'decision', text: `Decided and committed: ${d}`, tags: ['decision', 'ledger'] });
    n++;
  }
  for (const t of l.open) {
    store.add({ kind: 'task', text: `Open task: ${t}`, tags: ['task', 'open', 'ledger'] });
    n++;
  }
  return n;
}

module.exports = { buildLedger, formatLedger, persistLedger, commitSubject, BUDGET_CHARS };
