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
  assert.match(r.stdout, /\[context\]/, `hook did not run: ${String(r.stdout).slice(0, 120)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the generated hook actually runs through bash', { skip: !bashCanRunNode }, () => {
  const dir = sandbox();
  const r = runVia('bash', hookCommand('core'), dir);
  assert.match(r.stdout, /\[context\]/, `hook did not run: ${String(r.stdout).slice(0, 120)}`);
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
  for (const f of ['compact.cjs', 'config.cjs']) {
    fs.copyFileSync(path.join(ROOT, 'tools', f), path.join(dir, 'tools', f));
  }

  const settings = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude', 'settings.json'), 'utf8'));
  const core = (settings.hooks.SessionStart || [])
    .flatMap((g) => g.hooks || [])
    .find((h) => /learning-hook\.cjs"? core/.test(h.command));
  assert.ok(core, 'SessionStart must wire the core hook');

  const r = runVia('bash', core.command, dir);
  assert.match(r.stdout, /\[context\]/, `committed hook did not run: ${String(r.stdout).slice(0, 120)}`);
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
  assert.doesNotMatch(r.stdout, /\[context\]/, 'but never runs the hook');
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
  assert.match(r.stdout, /\[context\]/);
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
