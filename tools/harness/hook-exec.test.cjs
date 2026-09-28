'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { hookCommand } = require('../../bin/harness.js');

// A hook command one shell cannot parse still exits 0 in that shell, so Claude
// Code reports "hook success" for a hook that never ran. The only honest test is
// to execute the command and look for the hook's own output.

const ROOT = path.join(__dirname, '..', '..');
const PAYLOAD = JSON.stringify({ context_tokens: 600000, estimated_cache_write_usd: 4 });

// Isolate from the user's real settings, so `rcskills config compact off` on this
// machine cannot make these tests fail.
process.env.TOKEN_HARNESS_CONFIG = path.join(os.tmpdir(), 'token-harness-test-no-config.json');
delete process.env.TOKEN_HARNESS_COMPACT;

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-exec-'));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  return dir;
}

function runVia(shell, cmd, cwd) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: cwd };
  return shell === 'bash'
    ? spawnSync('bash', ['-c', cmd], { input: PAYLOAD, env, cwd, encoding: 'utf8' })
    : spawnSync(cmd, { input: PAYLOAD, env, cwd, encoding: 'utf8', shell: true });
}

// On a Windows dev box `bash` may resolve to WSL, which cannot see node or C:/
// paths; only run the bash cases where bash can actually launch node.
const bashCanRunNode = spawnSync('bash', ['-c', 'node --version'], { encoding: 'utf8' }).status === 0;

test('the generated hook command uses no shell-specific syntax', () => {
  const cmd = hookCommand('core');
  assert.doesNotMatch(cmd, /cmd \/c|IF EXIST|%\w+%/);
  assert.ok(!cmd.includes('\\'), 'backslashes are escape characters in bash');
});

test('the generated hook actually runs through the default shell', () => {
  const dir = sandbox();
  const r = runVia('default', hookCommand('core'), dir);
  assert.match(r.stdout, /\[next\]/, `hook did not run: ${String(r.stdout).slice(0, 120)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the generated hook actually runs through bash', { skip: !bashCanRunNode }, () => {
  const dir = sandbox();
  const r = runVia('bash', hookCommand('core'), dir);
  assert.match(r.stdout, /\[next\]/, `hook did not run: ${String(r.stdout).slice(0, 120)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the committed project hooks actually run through bash', { skip: !bashCanRunNode }, () => {
  // Copy the hook into a sandbox so running it cannot touch real memory.
  const dir = sandbox();
  const helpers = path.join(dir, '.claude', 'helpers');
  fs.mkdirSync(helpers, { recursive: true });
  fs.copyFileSync(path.join(ROOT, '.claude', 'helpers', 'learning-hook.cjs'), path.join(helpers, 'learning-hook.cjs'));
  // Mirror the real layout: the hook loads its compaction logic from tools/.
  fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
  for (const f of ['compact.cjs', 'config.cjs', 'next-command.cjs', 'hook-advice.cjs']) {
    fs.copyFileSync(path.join(ROOT, 'tools', f), path.join(dir, 'tools', f));
  }

  const settings = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude', 'settings.json'), 'utf8'));
  const core = (settings.hooks.SessionStart || [])
    .flatMap((g) => g.hooks || [])
    .find((h) => /learning-hook\.cjs"? core/.test(h.command));
  assert.ok(core, 'SessionStart must wire the core hook');

  const r = runVia('bash', core.command, dir);
  assert.match(r.stdout, /\[next\]/, `committed hook did not run: ${String(r.stdout).slice(0, 120)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the old cmd /c form is dead under bash', { skip: process.platform !== 'win32' || !bashCanRunNode }, () => {
  // Pins down the original bug. If this ever starts running the hook, the
  // explanation in harness.js is wrong and should be revisited.
  const dir = sandbox();
  const script = path.join(ROOT, '.claude', 'helpers', 'learning-hook.cjs');
  const old = `cmd /c "IF EXIST "${script}" (node "${script}" core) ELSE (exit 0)"`;
  const r = runVia('bash', old, dir);
  assert.strictEqual(r.status, 0, 'reports success');
  assert.doesNotMatch(r.stdout, /\[next\]/, 'but never runs the hook');
  fs.rmSync(dir, { recursive: true, force: true });
});

// A throwaway home directory, so global-mode writes never touch the real ~/.claude.
function fakeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-home-'));
  return { home, env: { HOME: home, USERPROFILE: home } };
}

function runHook(script, args, cwd, input, extraEnv) {
  return spawnSync(process.execPath, [script, ...args], {
    input,
    cwd,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: cwd, ...extraEnv },
  });
}

const HOOK = path.join(ROOT, '.claude', 'helpers', 'learning-hook.cjs');

test('a --global hook stands down inside the harness repo', () => {
  // Project settings already run it here; firing twice would double every outcome.
  const { home, env } = fakeHome();
  const r = runHook(HOOK, ['core', '--global'], ROOT, PAYLOAD, env);
  assert.strictEqual(r.stdout.trim(), '');
  fs.rmSync(home, { recursive: true, force: true });
});

test('a --global hook runs in any other project', () => {
  const dir = sandbox();
  const { home, env } = fakeHome();
  const r = runHook(HOOK, ['core', '--global'], dir, PAYLOAD, env);
  assert.match(r.stdout, /\[next\]/);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test('global mode never writes project data into the project working tree', () => {
  // Memory is built from prompts; it must not land where another repo could commit it.
  const dir = sandbox();
  const { home, env } = fakeHome();
  runHook(HOOK, ['core', '--global'], dir, PAYLOAD, env);

  assert.ok(!fs.existsSync(path.join(dir, '.claude', 'memory')), 'nothing written inside the project');
  const projects = path.join(home, '.claude', 'token-harness', 'projects');
  assert.strictEqual(fs.readdirSync(projects).length, 1, 'data kept under ~/.claude instead');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test('a new install says one line on its first session, and nothing after that', () => {
  // Everything else here speaks only when there is money on the table, so without
  // this line a fresh install is silent for hours and reads as broken.
  // A stand-in harness repo with an empty store, so this machine's own pinned
  // memory cannot stand in for the greeting.
  const harness = fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-install-'));
  fs.mkdirSync(path.join(harness, '.claude', 'helpers'), { recursive: true });
  fs.mkdirSync(path.join(harness, 'tools', 'memory'), { recursive: true });
  const hook = path.join(harness, '.claude', 'helpers', 'learning-hook.cjs');
  fs.copyFileSync(HOOK, hook);
  fs.copyFileSync(path.join(ROOT, 'tools', 'memory', 'store.cjs'), path.join(harness, 'tools', 'memory', 'store.cjs'));

  const dir = sandbox();
  const { home, env } = fakeHome();
  const quiet = JSON.stringify({ context_tokens: 1000 });

  const first = runHook(hook, ['core', '--global'], dir, quiet, env);
  assert.match(first.stdout, /^\[rcskills\] Installed\./);
  assert.match(first.stdout, /rcskills spend/, 'points at the one command worth running now');

  assert.strictEqual(
    runHook(hook, ['core', '--global'], dir, quiet, env).stdout.trim(),
    '',
    'silent from then on — which is what a new user would otherwise see from the start',
  );
  const other = sandbox();
  assert.strictEqual(
    runHook(hook, ['core', '--global'], other, quiet, env).stdout.trim(),
    '',
    'once per install, not once per project',
  );

  for (const d of [harness, dir, other, home]) fs.rmSync(d, { recursive: true, force: true });
});

test('pinned policy in the harness store reaches every project', () => {
  // Build a stand-in harness repo so the test never depends on real memory.
  const harness = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-harness-'));
  fs.mkdirSync(path.join(harness, '.claude', 'helpers'), { recursive: true });
  fs.mkdirSync(path.join(harness, 'tools', 'memory'), { recursive: true });
  const hook = path.join(harness, '.claude', 'helpers', 'learning-hook.cjs');
  fs.copyFileSync(HOOK, hook);
  fs.copyFileSync(path.join(ROOT, 'tools', 'memory', 'store.cjs'), path.join(harness, 'tools', 'memory', 'store.cjs'));

  const { MemoryStore } = require('../memory/store.cjs');
  const store = new MemoryStore({ path: path.join(harness, '.claude', 'memory', 'records.jsonl') });
  store.add({ text: 'standing policy that follows every project', pinned: true });
  store.save();

  const project = sandbox();
  const { home, env } = fakeHome();
  const r = runHook(hook, ['core', '--global'], project, JSON.stringify({ context_tokens: 1000 }), env);
  assert.match(r.stdout, /\[core\] standing policy that follows every project/);

  for (const d of [harness, project, home]) fs.rmSync(d, { recursive: true, force: true });
});

test('the Stop hook records the turn only when learning is on, in the same process', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-hook-'));
  const tp = path.join(dir, 't.jsonl');
  const db = path.join(dir, 'records.jsonl');
  fs.writeFileSync(tp, [
    { type: 'user', promptSource: 'sdk', origin: { kind: 'human' }, message: { content: 'rename foo to bar in src/a.js' } },
    { type: 'assistant', message: { model: 'claude-opus-5', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/r/src/a.js' } }] } },
    { type: 'assistant', message: { model: 'claude-opus-5', content: [{ type: 'text', text: 'Done.' }] } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  const stop = (args, env = {}) => spawnSync(process.execPath, [path.join(__dirname, '..', '..', '.claude', 'helpers', 'learning-hook.cjs'), 'loop', ...args], {
    cwd: dir,
    encoding: 'utf8',
    input: JSON.stringify({ transcript_path: tp, session_id: 'learn', stop_hook_active: false }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, SMART_MEMORY_PATH: db, TOKEN_HARNESS_CONFIG: path.join(dir, 'c.json'), TOKEN_HARNESS_LEARNING: '', ...env },
  });
  const outcomes = () => (fs.existsSync(db) ? fs.readFileSync(db, 'utf8').split('"kind":"outcome"').length - 1 : 0);

  assert.strictEqual(stop([]).stdout, '');
  assert.strictEqual(outcomes(), 0, 'standard: nothing recorded');
  stop(['--learn']);
  assert.strictEqual(outcomes(), 1, 'strict: recorded by the loop hook itself');
  // The store merges an identical record, so the config path is checked on a fresh store.
  fs.rmSync(db);
  stop([], { TOKEN_HARNESS_LEARNING: 'on' });
  assert.strictEqual(outcomes(), 1, 'plugin: rcskills config learning on');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the real hooks step Opus down after small work, and carry the reasoning across the switch', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-hook-'));
  const { home, env } = fakeHome();
  const hookEnv = { ...env, TOKEN_HARNESS_MODEL_SWITCH: '' };
  const tp = path.join(dir, 't.jsonl');
  const smallTurn = (i) => [
    { type: 'user', promptSource: 'sdk', origin: { kind: 'human' }, message: { content: `what does helper ${i} return?` } },
    { type: 'assistant', message: { model: 'claude-opus-5', content: [{ type: 'tool_use', name: 'Read', input: { file_path: `/r/h${i}.js` } }] } },
  ];
  fs.writeFileSync(tp, [
    ...smallTurn(1), ...smallTurn(2), ...smallTurn(3),
    {
      type: 'assistant',
      timestamp: new Date().toISOString(),
      message: {
        model: 'claude-opus-5',
        usage: { input_tokens: 10, cache_read_input_tokens: 200000, cache_creation_input_tokens: 0, output_tokens: 300 },
        content: [
          { type: 'thinking', thinking: 'Helpers are pure; the cache key must include the locale.' },
          { type: 'tool_use', name: 'TodoWrite', input: { todos: [{ content: 'add locale to the cache key', status: 'pending' }] } },
          { type: 'text', text: 'All three return strings.' },
        ],
      },
    },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  const recall = (prompt) => runHook(HOOK, ['recall'], dir, JSON.stringify({ prompt, transcript_path: tp, session_id: 'sw' }), hookEnv).stdout;

  // The prompt is read before it runs: small work on Opus is held once, at no token cost.
  const held = JSON.parse(recall('and helper four?'));
  assert.equal(held.decision, 'block');
  assert.match(held.reason, /^\[rcskills\] Before this runs: .*\/compact keep decisions and open tasks for "and helper four\?", then \/model sonnet, then send this again/);
  const resent = recall('and helper four?');
  assert.doesNotMatch(resent, /"decision"/, 'sending it again runs it');
  assert.match(resent, /^\[next\] .*then \/model sonnet/m, 'and the reply still ends with the switch');
  assert.doesNotMatch(recall('/compact keep decisions'), /"decision"/, 'a slash command is never held');

  // The user switches. Nothing is written for a same-family change.
  const switchHook = (from, to) => runHook(HOOK, ['switch'], dir, JSON.stringify({
    from_model: from, to_model: to, source: 'command', transcript_path: tp, session_id: 'sw', context_tokens: 200000,
  }), hookEnv);
  switchHook('claude-opus-5', 'claude-opus-5-5');
  assert.doesNotMatch(recall('still there?'), /\[handoff\]/, 'Opus to Opus strands nothing');
  switchHook('claude-opus-5', 'claude-sonnet-5');
  const after = recall('carry on');
  assert.match(after, /\[handoff\] The model changed from claude-opus-5 to claude-sonnet-5/);
  assert.match(after, /the cache key must include the locale/, 'the reasoning survives as text');
  assert.match(after, /open tasks: add locale to the cache key/);
  assert.doesNotMatch(recall('and again'), /\[handoff\]/, 'shown once');

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});
