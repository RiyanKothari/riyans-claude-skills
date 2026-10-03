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

const MAX = { asks: 6, rules: 5, decisions: 8, noted: 6, open: 8, files: 12 };
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
 * A request that sets a rule rather than asking for one piece of work: the user's own
 * decisions ("only Opus models", "never route to older models", "from now on…").
 */
const STANDING = /\b(?:always|never|only|don'?t|do not|from now on|make sure|every time|whenever|stop doing|no more)\b/i;

/**
 * A decision Claude wrote down as one: a line starting "Decision:" or "Decided:".
 * The skill asks for this whenever something is settled that no commit will record.
 */
const DECISION_LINE = /^\s*(?:[-*]\s*)?\**(?:Decision|Decided)\**\s*:\s*\**\s*(.+)$/gim;

/**
 * Files with uncommitted changes in `dir`: work in flight that no commit records.
 * Empty when `dir` is not a git checkout or git is unavailable.
 * @param {string|undefined} dir
 */
function uncommittedFiles(dir) {
  if (!dir) return [];
  try {
    const { spawnSync } = require('child_process');
    // Only the project's own repository: git climbs to any parent repo, and a home
    // folder under version control would list every unrelated file in it.
    const top = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 3000 });
    const norm = (p) => require('path').resolve(String(p).trim()).replace(/\\/g, '/').toLowerCase();
    if (top.status !== 0 || norm(top.stdout) !== norm(dir)) return [];
    const r = spawnSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8', timeout: 3000 });
    if (r.status !== 0) return [];
    return String(r.stdout).split('\n').map((l) => l.slice(3).trim().replace(/^"|"$/g, ''))
      .filter((f) => f && !/(?:^|\/)\.claude\/(?:memory|worktrees)\//.test(f)).slice(0, MAX.files);
  } catch {
    return [];
  }
}

/**
 * @typedef {{asks: string[], decisions: string[], noted?: string[], rules?: string[], open: string[], files: string[], uncommitted?: string[]}} Ledger
 */

/**
 * @param {string} filePath a session transcript (.jsonl)
 * @param {{cwd?: string}} [opts] the project directory, to list uncommitted work
 * @returns {Ledger}
 */
function buildLedger(filePath, opts = {}) {
  /** @type {string[]} */ const asks = [];
  /** @type {string[]} */ const rules = [];
  /** @type {string[]} */ const decisions = [];
  /** @type {string[]} */ const noted = [];
  /** @type {string[]} */ const files = [];
  /** @type {Array<{content?: string, status?: string}>|null} */ let todos = null;
  let text = '';
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { asks: [], decisions: [], noted: [], rules: [], open: [], files: [], uncommitted: [] };
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
      if (!ask.startsWith('/') && !isSystemText(ask)) {
        asks.push(clip(ask, 140));
        if (STANDING.test(ask)) rules.push(clip(ask, 160));
      }
      continue;
    }
    const content = o.type === 'assistant' && o.message && Array.isArray(o.message.content) ? o.message.content : [];
    for (const b of content) {
      if (b && b.type === 'text' && typeof b.text === 'string') {
        for (const m of b.text.matchAll(DECISION_LINE)) noted.push(clip(m[1], 160));
        continue;
      }
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
    rules: lastDistinct(rules, MAX.rules),
    decisions: lastDistinct(decisions, MAX.decisions),
    noted: lastDistinct(noted, MAX.noted),
    open: open.slice(0, MAX.open),
    files: lastDistinct(files, MAX.files).map((f) => f.split('/').slice(-2).join('/')),
    uncommitted: uncommittedFiles(opts.cwd),
  };
}

/** @param {Ledger|null|undefined} l */
const empty = (l) => !l || ['asks', 'rules', 'decisions', 'noted', 'open', 'files', 'uncommitted']
  .every((k) => !(/** @type {any} */ (l)[k] || []).length);

/**
 * One bounded block of context. `lead` says where it came from. The parts that bind
 * future work come first, so a trim at the budget cuts the least important.
 * @param {Ledger} l
 * @param {string} lead
 */
function formatLedger(l, lead) {
  if (empty(l)) return null;
  const parts = [lead];
  if ((l.rules || []).length) parts.push(`your standing instructions, oldest first (a later one overrides an earlier): ${(l.rules || []).map((r) => `"${r}"`).join(' · ')}`);
  if (l.decisions.length) parts.push(`decided and committed: ${l.decisions.join(' · ')}`);
  if ((l.noted || []).length) parts.push(`decided, not committed: ${(l.noted || []).join(' · ')}`);
  if (l.open.length) parts.push(`still open: ${l.open.join(' · ')}`);
  if ((l.uncommitted || []).length) parts.push(`uncommitted changes in: ${(l.uncommitted || []).join(', ')}`);
  if (l.asks.length) parts.push(`recent asks: ${l.asks.map((a) => `"${a}"`).join(' · ')}`);
  if (l.files.length) parts.push(`files edited: ${l.files.join(', ')}`);
  parts.push('Continue from this; do not redo decided work.');
  let out = parts.join('. ').replace(/\.\./g, '.');
  if (out.length > BUDGET_CHARS) out = `${out.slice(0, BUDGET_CHARS - 1)}…`;
  return out;
}

/**
 * Put what binds future work where future sessions look: the memory store, recalled
 * per prompt by relevance. Exact repeats only refresh the existing record.
 * @param {{add: (r: object) => any}} store
 * @param {Ledger} l
 */
function persistLedger(store, l) {
  const rows = [
    ...(l.rules || []).map((t) => ({ kind: 'decision', text: `User instruction: ${t}`, tags: ['decision', 'instruction', 'ledger'] })),
    ...l.decisions.map((t) => ({ kind: 'decision', text: `Decided and committed: ${t}`, tags: ['decision', 'ledger'] })),
    ...(l.noted || []).map((t) => ({ kind: 'decision', text: `Decided: ${t}`, tags: ['decision', 'ledger'] })),
    ...l.open.map((t) => ({ kind: 'task', text: `Open task: ${t}`, tags: ['task', 'open', 'ledger'] })),
  ];
  for (const r of rows) store.add(r);
  return rows.length;
}

module.exports = { buildLedger, formatLedger, persistLedger, commitSubject, uncommittedFiles, BUDGET_CHARS };
