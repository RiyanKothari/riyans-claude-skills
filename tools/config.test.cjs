'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { load, set, DEFAULTS } = require('./config.cjs');

delete process.env.TOKEN_HARNESS_COMPACT;
delete process.env.TOKEN_HARNESS_COMPACT_REMIND;

// Points the config at a throwaway file so the real ~/.claude is never touched.
function withConfig(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
  const file = path.join(dir, 'config.json');
  if (content !== undefined) fs.writeFileSync(file, content);
  process.env.TOKEN_HARNESS_CONFIG = file;
  return {
    file,
    clean() {
      delete process.env.TOKEN_HARNESS_CONFIG;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('defaults apply when there is no config file', () => {
  const c = withConfig();
  assert.deepStrictEqual(load({}).compact, DEFAULTS.compact);
  c.clean();
});

test('the config file overrides defaults', () => {
  const c = withConfig(JSON.stringify({ compact: { threshold: 250000 } }));
  const s = load({}).compact;
  assert.strictEqual(s.threshold, 250000);
  assert.strictEqual(s.enabled, true);
  c.clean();
});

test('environment variables override the file', () => {
  const c = withConfig(JSON.stringify({ compact: { enabled: true, threshold: 250000 } }));
  assert.strictEqual(load({ TOKEN_HARNESS_COMPACT: 'off' }).compact.enabled, false);
  assert.strictEqual(load({ TOKEN_HARNESS_COMPACT: '120000' }).compact.threshold, 120000);
  assert.strictEqual(load({ TOKEN_HARNESS_COMPACT_REMIND: '50000' }).compact.remindEvery, 50000);
  c.clean();
});

test('invalid values in the file fall back to defaults', () => {
  const c = withConfig(JSON.stringify({ compact: { threshold: 'lots', remindEvery: -5 } }));
  const s = load({}).compact;
  assert.strictEqual(s.threshold, DEFAULTS.compact.threshold);
  assert.strictEqual(s.remindEvery, DEFAULTS.compact.remindEvery);
  c.clean();
});

test('set writes a setting and load reads it back', () => {
  const c = withConfig();
  set('compact', '200000');
  assert.strictEqual(load({}).compact.threshold, 200000);

  set('compact', 'off');
  assert.strictEqual(load({}).compact.enabled, false);
  assert.strictEqual(load({}).compact.threshold, 200000, 'switching off keeps the threshold');

  set('compact-remind', '80000');
  assert.strictEqual(load({}).compact.remindEvery, 80000);
  c.clean();
});

test('set keeps unrelated keys already in the file', () => {
  const c = withConfig(JSON.stringify({ somethingElse: 1 }));
  set('compact', 'off');
  assert.strictEqual(JSON.parse(fs.readFileSync(c.file, 'utf8')).somethingElse, 1);
  c.clean();
});

test('set rejects bad values', () => {
  const c = withConfig();
  assert.throws(() => set('compact', 'sometimes'), /on, off or a token count/);
  assert.throws(() => set('compact-remind', 'x'), /token count/);
  assert.throws(() => set('colour', 'blue'), /unknown setting/);
  c.clean();
});

test('set refuses to overwrite a config file it cannot parse', () => {
  // Same rule as the installer: an unreadable file is not an empty one.
  const c = withConfig('{ not json');
  assert.throws(() => set('compact', 'off'), /refusing to overwrite/);
  assert.strictEqual(fs.readFileSync(c.file, 'utf8'), '{ not json');
  c.clean();
});

test('rcskills config sets and shows the setting from any directory', () => {
  const c = withConfig();
  const harness = path.join(__dirname, '..', 'bin', 'harness.js');
  const run = (args) => spawnSync(process.execPath, [harness, 'config', ...args], {
    cwd: os.tmpdir(),
    encoding: 'utf8',
    env: { ...process.env },
  });

  const ok = run(['compact', '250000']);
  assert.strictEqual(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /first prompt at: 250k/);

  const bad = run(['compact', 'sometimes']);
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stderr, /usage: rcskills config/);
  c.clean();
});
