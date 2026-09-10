'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const HOOK = path.join(ROOT, '.claude', 'helpers', 'model-route-hook.cjs');

function runHook(input) {
  return execFileSync(process.execPath, [HOOK], {
    input,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: ROOT },
  });
}

test('hook emits a delegation hint for trivial work', () => {
  const out = runHook(JSON.stringify({ prompt: 'fix a typo in the readme' }));
  assert.match(out, /model-router/);
  assert.match(out, /haiku/);
});

test('hook stays silent on complex work', () => {
  const out = runHook(
    JSON.stringify({ prompt: 'refactor the auth architecture across the codebase' }),
  );
  assert.strictEqual(out.trim(), '');
});

test('hook stays silent on reasoning prompts', () => {
  const out = runHook(JSON.stringify({ prompt: 'why does this test fail only in CI' }));
  assert.strictEqual(out.trim(), '');
});

test('hook stays silent on an empty prompt', () => {
  assert.strictEqual(runHook(JSON.stringify({ prompt: '' })).trim(), '');
});

test('hook tolerates non-JSON stdin without throwing', () => {
  const out = runHook('fix a typo in the readme');
  assert.match(out, /haiku/);
});

test('hook never exits non-zero', () => {
  // A hook that throws would break every prompt submission, so failure must
  // always degrade to silence.
  for (const input of ['', '{bad json', JSON.stringify({ nope: 1 })]) {
    assert.doesNotThrow(() => runHook(input));
  }
});
