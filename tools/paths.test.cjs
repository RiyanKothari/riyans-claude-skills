'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { HARNESS_ROOT, isInside, projectRoot, projectDataDir } = require('./paths.cjs');

// Isolate from the user's real settings, so a local compaction preference cannot
// stop the hook writing the data this file checks for.
process.env.TOKEN_HARNESS_CONFIG = path.join(os.tmpdir(), 'token-harness-test-no-config.json');
delete process.env.TOKEN_HARNESS_COMPACT;

test('inside the harness repo, data stays in its gitignored .claude/memory', () => {
  const expected = path.join(HARNESS_ROOT, '.claude', 'memory');
  assert.strictEqual(projectDataDir(HARNESS_ROOT), expected);
  assert.strictEqual(projectDataDir(path.join(HARNESS_ROOT, 'tools')), expected);
});

test('any other project keeps its data under ~/.claude, never in its own tree', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paths-'));
  const data = projectDataDir(dir);
  assert.ok(isInside(data, path.join(os.homedir(), '.claude', 'token-harness', 'projects')));
  assert.ok(!isInside(data, dir));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('isInside is not fooled by a shared name prefix', () => {
  assert.ok(!isInside('/a/project-two', '/a/project'));
  assert.ok(isInside('/a/project/sub', '/a/project'));
  assert.ok(isInside('/a/project', '/a/project'));
});

test('projectRoot prefers CLAUDE_PROJECT_DIR over the working directory', () => {
  assert.strictEqual(projectRoot({ CLAUDE_PROJECT_DIR: '/x/y' }, '/cwd'), '/x/y');
  assert.strictEqual(projectRoot({}, '/cwd'), '/cwd');
});

test('the CLI and the global hook agree on where a project lives', () => {
  // If these ever diverge, the CLI and the hooks silently read different stores.
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'paths-proj-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'paths-home-'));
  const hook = path.join(HARNESS_ROOT, '.claude', 'helpers', 'learning-hook.cjs');

  spawnSync(process.execPath, [hook, 'core', '--global'], {
    input: JSON.stringify({ context_tokens: 400000 }),
    cwd: project,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: project, HOME: home, USERPROFILE: home },
  });

  const written = fs.readdirSync(path.join(home, '.claude', 'token-harness', 'projects'));
  assert.deepStrictEqual(written, [path.basename(projectDataDir(project))]);

  fs.rmSync(project, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});
