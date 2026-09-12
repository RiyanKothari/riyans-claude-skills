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
const PAYLOAD = JSON.stringify({ context_tokens: 400000, estimated_cache_write_usd: 4 });

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
