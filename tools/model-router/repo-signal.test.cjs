'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { repoSignal, extractPaths, clearCache } = require('./repo-signal.cjs');

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-signal-'));
  fs.writeFileSync(path.join(root, 'tiny.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(root, 'core.js'), `${'// line\n'.repeat(800)}module.exports = {};\n`);
  for (let i = 0; i < 12; i++) {
    fs.writeFileSync(path.join(root, `dep${i}.js`), "require('./core');\n");
  }
  clearCache();
  return root;
}

test('extractPaths finds file-like tokens', () => {
  const p = extractPaths('fix the typo in src/auth/login.ts and README.md');
  assert.ok(p.includes('src/auth/login.ts'));
  assert.ok(p.includes('README.md'));
});

test('extractPaths ignores prose without paths', () => {
  assert.strictEqual(extractPaths('refactor the auth flow').length, 0);
});

test('a prompt with no file mentioned scores zero', () => {
  const root = makeRepo();
  assert.strictEqual(repoSignal('rename a variable', { root }).score, 0);
});

test('a small isolated file scores low', () => {
  const root = makeRepo();
  const s = repoSignal('fix a typo in tiny.js', { root });
  assert.strictEqual(s.score, 0);
  assert.ok(s.files[0].exists);
});

test('a large widely-imported file scores high', () => {
  const root = makeRepo();
  const s = repoSignal('fix a typo in core.js', { root });
  assert.ok(s.score >= 3, `expected >=3, got ${s.score} (${s.reason})`);
  assert.ok(s.files[0].lines > 500);
  assert.ok(s.files[0].importers > 10);
});

test('a file named but absent from the repo scores zero', () => {
  const root = makeRepo();
  const s = repoSignal('edit does/not/exist.js', { root });
  assert.strictEqual(s.score, 0);
  assert.match(s.reason, /not found/);
});

test('results are cached per path', () => {
  const root = makeRepo();
  const a = repoSignal('touch core.js', { root });
  const b = repoSignal('touch core.js', { root });
  assert.deepStrictEqual(a.files[0], b.files[0]);
});
