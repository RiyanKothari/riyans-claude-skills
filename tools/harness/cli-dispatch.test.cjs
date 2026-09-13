'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// These run the CLI from directories that are NOT the harness repo, because that
// is the only place the global CLI is ever used for real.

const ROOT = path.join(__dirname, '..', '..');
const HARNESS = path.join(ROOT, 'bin', 'harness.js');

function run(args, cwd, env = {}) {
  return spawnSync(process.execPath, [HARNESS, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('route works from a directory that is not the harness repo', () => {
  const dir = tmp('dispatch-');
  const r = run(['route', 'fix a typo in the readme'], dir);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).tier, 'trivial');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('mem keeps another project\'s memory under ~/.claude, not in the project', () => {
  const dir = tmp('dispatch-proj-');
  const home = tmp('dispatch-home-');
  const env = { HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: dir, SMART_MEMORY_PATH: '' };

  const r = run(['mem', 'add', 'a durable fact about this project'], dir, env);
  assert.strictEqual(r.status, 0, r.stderr);

  assert.ok(!fs.existsSync(path.join(dir, '.claude')), 'nothing may be written inside the project');
  const projects = path.join(home, '.claude', 'token-harness', 'projects');
  assert.strictEqual(fs.readdirSync(projects).length, 1);

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test('lint runs against an explicit skills directory', () => {
  const r = run(['lint', path.join(ROOT, 'skills')], os.tmpdir());
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, / 0 error/);
});

test('an unknown command prints usage that lists the tools', () => {
  const r = run(['nonsense'], os.tmpdir());
  assert.match(r.stdout, /route\|mem\|scorecard/);
});
