'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const HARNESS = path.join(__dirname, '..', '..', 'bin', 'harness.js');

function sandbox(settingsContent) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-e2e-'));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  if (settingsContent !== undefined) {
    fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), settingsContent);
  }
  return dir;
}

function run(dir, args) {
  try {
    const stdout = execFileSync(process.execPath, [HARNESS, ...args], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

function settings(dir) {
  const raw = fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8');
  return JSON.parse(raw.replace(/^﻿/, ''));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test('install into an empty project creates skill, hooks and state', () => {
  const dir = sandbox();
  const r = run(dir, ['install', '--profile', 'strict']);
  assert.strictEqual(r.code, 0, r.stderr);

  assert.ok(fs.existsSync(path.join(dir, '.claude', 'skills', 'token-harness', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(dir, '.claude', 'harness-state.json')));

  const s = settings(dir);
  assert.ok(s.hooks.SessionStart);
  assert.ok(s.hooks.UserPromptSubmit);
  assert.ok(s.hooks.Stop);
  cleanup(dir);
});

test('reference docs are installed alongside SKILL.md', () => {
  const dir = sandbox();
  run(dir, ['install']);
  const refs = path.join(dir, '.claude', 'skills', 'token-harness', 'references');
  assert.ok(fs.existsSync(path.join(refs, 'router.md')));
  assert.ok(fs.existsSync(path.join(refs, 'memory.md')));
  cleanup(dir);
});

test('minimal profile installs the skill but wires no hooks', () => {
  const dir = sandbox();
  run(dir, ['install', '--profile', 'minimal']);
  assert.ok(fs.existsSync(path.join(dir, '.claude', 'skills', 'token-harness', 'SKILL.md')));
  assert.deepStrictEqual(settings(dir).hooks || {}, {});
  cleanup(dir);
});

test('an existing config survives install untouched', () => {
  const dir = sandbox(JSON.stringify({
    model: 'claude-opus-5',
    env: { FOO: '1' },
    hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'USER-HOOK' }] }] },
  }));

  run(dir, ['install', '--profile', 'strict']);
  const s = settings(dir);

  assert.strictEqual(s.model, 'claude-opus-5');
  assert.deepStrictEqual(s.env, { FOO: '1' });
  assert.ok(JSON.stringify(s).includes('USER-HOOK'));
  cleanup(dir);
});

test('a settings file with a UTF-8 BOM does not destroy the config', () => {
  // Regression: the BOM made JSON.parse throw, install fell back to {} and
  // wrote that over everything the user had.
  const dir = sandbox(`﻿${JSON.stringify({ model: 'claude-opus-5' })}`);
  const r = run(dir, ['install']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(settings(dir).model, 'claude-opus-5');
  cleanup(dir);
});

test('install refuses on unparseable settings and leaves the file alone', () => {
  const dir = sandbox('{ not json at all');
  const r = run(dir, ['install']);

  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /refusing to install/);
  assert.strictEqual(
    fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'),
    '{ not json at all',
  );
  cleanup(dir);
});

test('install is idempotent', () => {
  const dir = sandbox();
  run(dir, ['install', '--profile', 'strict']);
  const first = JSON.stringify(settings(dir).hooks);
  const r = run(dir, ['install', '--profile', 'strict']);

  assert.match(r.stdout, /already wired/);
  assert.strictEqual(JSON.stringify(settings(dir).hooks), first);
  cleanup(dir);
});

test('install backs settings up before writing', () => {
  const dir = sandbox(JSON.stringify({ model: 'x' }));
  run(dir, ['install']);
  const backups = fs.readdirSync(path.join(dir, '.claude')).filter((f) => f.includes('.bak-'));
  assert.strictEqual(backups.length, 1);
  cleanup(dir);
});

test('doctor passes on a fresh install and fails when nothing is installed', () => {
  const clean = sandbox();
  assert.strictEqual(run(clean, ['doctor']).code, 1);
  cleanup(clean);

  const dir = sandbox();
  run(dir, ['install', '--profile', 'standard']);
  const r = run(dir, ['doctor']);
  assert.strictEqual(r.code, 0, r.stdout);
  assert.match(r.stdout, /all checks passed/);
  cleanup(dir);
});

test('doctor detects hooks removed behind its back', () => {
  const dir = sandbox();
  run(dir, ['install', '--profile', 'strict']);

  const p = path.join(dir, '.claude', 'settings.json');
  fs.writeFileSync(p, JSON.stringify({ hooks: {} }));

  const r = run(dir, ['doctor']);
  assert.strictEqual(r.code, 1);
  assert.match(r.stdout, /FAIL/);
  cleanup(dir);
});

test('uninstall removes our hooks and the skill but keeps user data', () => {
  const dir = sandbox(JSON.stringify({
    model: 'claude-opus-5',
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'USER-STOP' }] }] },
  }));
  run(dir, ['install', '--profile', 'strict']);

  const memDir = path.join(dir, '.claude', 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, 'records.jsonl'), '{"text":"mine"}\n');

  const r = run(dir, ['uninstall']);
  assert.strictEqual(r.code, 0, r.stderr);

  const s = settings(dir);
  assert.ok(!JSON.stringify(s).includes('riyans-claude-skills'), 'harness hooks must be gone');
  assert.ok(JSON.stringify(s).includes('USER-STOP'), 'user hook must survive');
  assert.strictEqual(s.model, 'claude-opus-5');

  assert.ok(!fs.existsSync(path.join(dir, '.claude', 'skills', 'token-harness')));
  assert.ok(fs.existsSync(path.join(memDir, 'records.jsonl')), 'user data must survive');
  cleanup(dir);
});

test('uninstall with nothing installed is a safe no-op', () => {
  const dir = sandbox();
  const r = run(dir, ['uninstall']);
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /no install found/);
  cleanup(dir);
});

test('status reports the installed profile', () => {
  const dir = sandbox();
  run(dir, ['install', '--profile', 'strict']);
  const r = run(dir, ['status']);
  assert.match(r.stdout, /"profile": "strict"/);
  cleanup(dir);
});

test('an unknown profile is rejected before anything is written', () => {
  const dir = sandbox();
  const r = run(dir, ['install', '--profile', 'nonsense']);
  assert.match(r.stdout, /unknown profile/);
  assert.ok(!fs.existsSync(path.join(dir, '.claude', 'harness-state.json')));
  cleanup(dir);
});

test('no args prints usage rather than doing anything', () => {
  const dir = sandbox();
  const r = run(dir, []);
  assert.match(r.stdout, /Usage/);
  assert.ok(!fs.existsSync(path.join(dir, '.claude', 'harness-state.json')));
  cleanup(dir);
});

test('install then uninstall then install again ends up clean', () => {
  const dir = sandbox();
  run(dir, ['install', '--profile', 'strict']);
  run(dir, ['uninstall']);
  run(dir, ['install', '--profile', 'strict']);

  const groups = Object.values(settings(dir).hooks || {}).flat();
  const ours = groups.filter((g) => g && g['riyans-claude-skills']);
  const modes = require('../../bin/harness.js').PROFILES.strict.hooks.length;
  assert.strictEqual(ours.length, modes, 'exactly one hook group per mode');
  cleanup(dir);
});
