'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildLedger, formatLedger, persistLedger, commitSubject, BUDGET_CHARS } = require('./ledger.cjs');

const HOOK = path.join(__dirname, '..', '.claude', 'helpers', 'learning-hook.cjs');
const human = (content) => ({ type: 'user', promptSource: 'sdk', origin: { kind: 'human' }, message: { content } });
const tool = (name, input) => ({ type: 'assistant', message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', name, input }] } });

function transcript(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
  const file = path.join(dir, 't.jsonl');
  fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return { dir, file };
}

test('a commit subject is read from -m and from a heredoc, and only from a real git commit', () => {
  assert.strictEqual(commitSubject('git add -A && git commit -q -m "Price Opus 5.5\n\nbody"'), 'Price Opus 5.5');
  assert.strictEqual(commitSubject("git commit -m 'one line'"), 'one line');
  assert.strictEqual(commitSubject('git -C repo commit -am "with a \\"quote\\""'), 'with a "quote"');
  assert.strictEqual(commitSubject("git commit -m \"$(cat <<'EOF'\nHeredoc subject\n\nbody\nEOF\n)\""), 'Heredoc subject');
  assert.strictEqual(commitSubject("spawnSync('git', ['-c', 'user.name=t', 'commit', '-qm', 'init'])"), null, 'a test that mentions commit');
  assert.strictEqual(commitSubject('git status && git log'), null);
  assert.strictEqual(commitSubject(undefined), null);
});

test('the ledger holds asks, decisions, open tasks and files, without noise', () => {
  const t = transcript([
    human('build the exporter'),
    human('/compact keep decisions'),
    { type: 'user', promptSource: 'system', origin: { kind: 'task-notification' }, message: { content: '<task-notification>x</task-notification>' } },
    tool('Edit', { file_path: 'C:\\repo\\tools\\export.cjs' }),
    tool('Write', { file_path: 'C:/Users/me/AppData/Local/Temp/scratchpad/note.txt' }),
    tool('Bash', { command: 'git commit -q -m "Stream the export instead of buffering"' }),
    tool('TodoWrite', { todos: [{ content: 'write the CSV writer', status: 'completed' }, { content: 'add retries', status: 'pending' }] }),
    human('build the exporter'),
  ]);
  const l = buildLedger(t.file);
  assert.deepStrictEqual(l.asks, ['build the exporter'], 'deduped; slash commands and system notices left out');
  assert.deepStrictEqual(l.decisions, ['Stream the export instead of buffering']);
  assert.deepStrictEqual(l.open, ['add retries'], 'the last todo list, open items only');
  assert.deepStrictEqual(l.files, ['tools/export.cjs'], 'scratch files left out, paths shortened');
  fs.rmSync(t.dir, { recursive: true, force: true });
});

test('the formatted ledger is bounded and says how to use it; an empty one says nothing', () => {
  const big = { asks: Array(6).fill('a'.repeat(140)), decisions: Array(8).fill('d'.repeat(160)), open: Array(8).fill('o'.repeat(120)), files: [] };
  const out = String(formatLedger(big, '[ledger] lead'));
  assert.ok(out.length <= BUDGET_CHARS, `${out.length} chars`);
  const small = String(formatLedger({ asks: ['x'], decisions: ['ship it'], open: [], files: ['a.js'] }, '[ledger] lead'));
  assert.strictEqual(small, '[ledger] lead. decided and committed: ship it. recent asks: "x". files edited: a.js. Continue from this; do not redo decided work.');
  assert.strictEqual(formatLedger({ asks: [], decisions: [], open: [], files: [] }, 'x'), null);
  assert.strictEqual(buildLedger(path.join(os.tmpdir(), 'no-such-transcript.jsonl')).asks.length, 0, 'a missing transcript is an empty ledger');
});

test('uncommitted decisions are kept: your rules, Decision: lines, and work in flight', () => {
  const t = transcript([
    human('fix the export bug'),
    human('from now on, never push without CI passing'),
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Looked at both.\nDecision: keep Opus 5.5 as the default\n- **Decided:** drop the replay' }] } },
  ]);
  const repo = path.join(t.dir, 'repo');
  fs.mkdirSync(repo);
  const git = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
  git('init', '-q');
  fs.writeFileSync(path.join(repo, 'a.js'), '1');
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'i');
  fs.writeFileSync(path.join(repo, 'a.js'), '2');
  fs.writeFileSync(path.join(repo, 'new.js'), 'x');

  const l = buildLedger(t.file, { cwd: repo });
  assert.deepStrictEqual(l.rules, ['from now on, never push without CI passing'], 'a rule, not a one-off ask');
  assert.deepStrictEqual(l.noted, ['keep Opus 5.5 as the default', 'drop the replay']);
  assert.deepStrictEqual(l.uncommitted, ['a.js', 'new.js']);
  const out = String(formatLedger(l, '[ledger] lead'));
  assert.match(out, /your standing instructions, oldest first \(a later one overrides an earlier\): "from now on, never push without CI passing"\. decided, not committed: keep Opus 5\.5 as the default · drop the replay\. uncommitted changes in: a\.js, new\.js/);
  const added = [];
  persistLedger({ add: (r) => added.push(r.text) }, l);
  assert.deepStrictEqual(added, ['User instruction: from now on, never push without CI passing', 'Decided: keep Opus 5.5 as the default', 'Decided: drop the replay']);
  assert.deepStrictEqual(buildLedger(t.file, { cwd: t.dir }).uncommitted, [], 'not a git checkout: nothing');
  fs.rmSync(t.dir, { recursive: true, force: true });
});

test('decisions and open tasks go into memory, once each', () => {
  const added = [];
  const store = { add: (r) => added.push(r) };
  assert.strictEqual(persistLedger(store, { asks: [], files: [], decisions: ['Stream the export'], open: ['add retries'] }), 2);
  assert.deepStrictEqual(added.map((r) => [r.kind, r.text]), [['decision', 'Decided and committed: Stream the export'], ['task', 'Open task: add retries']]);
});

test('the real hooks keep the ledger across /compact, into the next session, and into recall', () => {
  const t = transcript([
    human('build the exporter'),
    tool('Edit', { file_path: '/repo/tools/export.cjs' }),
    tool('Bash', { command: 'git commit -q -m "Stream the export instead of buffering"' }),
    tool('TodoWrite', { todos: [{ content: 'add retries to the exporter', status: 'in_progress' }] }),
  ]);
  const home = path.join(t.dir, 'home');
  fs.mkdirSync(home);
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: t.dir, TOKEN_HARNESS_COMPACT: 'off',
    TOKEN_HARNESS_MODEL_SWITCH: 'off', SMART_MEMORY_PATH: path.join(t.dir, 'records.jsonl'),
  };
  const run = (mode, input) => spawnSync(process.execPath, [HOOK, mode], { input: JSON.stringify(input), cwd: t.dir, encoding: 'utf8', env }).stdout;

  run('precompact', { session_id: 's1', transcript_path: t.file, compaction_reason: 'manual' });
  const after = run('core', { session_id: 's1', source: 'compact', transcript_path: t.file });
  assert.match(after, /^\[ledger\] Before this \/compact, this session\. decided and committed: Stream the export instead of buffering\. still open: add retries to the exporter\. recent asks: "build the exporter"\. files edited: tools\/export\.cjs\./m);
  assert.doesNotMatch(after, /^\[last session/m, 'the thinner handoff line is not repeated');

  assert.doesNotMatch(run('core', { session_id: 's1', source: 'resume' }), /\[ledger\]/, 'a resumed, uncompacted conversation needs nothing');
  const next = run('core', { session_id: 's2', source: 'startup' });
  assert.match(next, /^\[ledger\] The last compacted session \(0h ago\)\. decided and committed: Stream the export instead of buffering\. still open: add retries to the exporter\. Continue/m);

  const recall = run('recall', { session_id: 's3', prompt: 'add retries to the exporter now', transcript_path: t.file });
  assert.match(recall, /Open task: add retries to the exporter/, 'a later prompt on the topic recalls it');
  fs.rmSync(t.dir, { recursive: true, force: true });
});
