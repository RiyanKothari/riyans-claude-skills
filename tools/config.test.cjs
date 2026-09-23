'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { load, set, describe, DEFAULTS } = require('./config.cjs');

delete process.env.TOKEN_HARNESS_COMPACT;
delete process.env.TOKEN_HARNESS_COMPACT_BUDGET;
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

test('defaults apply when there is no config file, and are dynamic', () => {
  const c = withConfig();
  assert.deepStrictEqual(load({}).compact, DEFAULTS.compact);
  assert.strictEqual(load({}).compact.mode, 'dynamic');
  c.clean();
});

test('the config file overrides defaults', () => {
  const c = withConfig(JSON.stringify({ compact: { budgetUsd: 0.4, mode: 'fixed', threshold: 250000 } }));
  const s = load({}).compact;
  assert.strictEqual(s.mode, 'fixed');
  assert.strictEqual(s.threshold, 250000);
  assert.strictEqual(s.budgetUsd, 0.4);
  c.clean();
});

test('environment variables override the file', () => {
  const c = withConfig(JSON.stringify({ compact: { mode: 'dynamic', budgetUsd: 0.15 } }));
  assert.strictEqual(load({ TOKEN_HARNESS_COMPACT: 'off' }).compact.enabled, false);

  const fixed = load({ TOKEN_HARNESS_COMPACT: '120000' }).compact;
  assert.strictEqual(fixed.mode, 'fixed');
  assert.strictEqual(fixed.threshold, 120000);

  assert.strictEqual(load({ TOKEN_HARNESS_COMPACT: 'dynamic' }).compact.mode, 'dynamic');
  assert.strictEqual(load({ TOKEN_HARNESS_COMPACT_BUDGET: '0.3' }).compact.budgetUsd, 0.3);
  assert.strictEqual(load({ TOKEN_HARNESS_COMPACT_REMIND: '50000' }).compact.remindEvery, 50000);
  c.clean();
});

test('invalid values in the file fall back to defaults', () => {
  const c = withConfig(JSON.stringify({
    compact: { mode: 'weird', threshold: 'lots', remindEvery: -5, budgetUsd: 'cheap', qualityShare: 7 },
  }));
  const s = load({}).compact;
  assert.strictEqual(s.mode, 'dynamic');
  assert.strictEqual(s.threshold, DEFAULTS.compact.threshold);
  assert.strictEqual(s.remindEvery, DEFAULTS.compact.remindEvery);
  assert.strictEqual(s.budgetUsd, DEFAULTS.compact.budgetUsd);
  assert.strictEqual(s.qualityShare, DEFAULTS.compact.qualityShare);
  c.clean();
});

test('set writes each setting and load reads it back', () => {
  const c = withConfig();
  set('compact', '200000');
  assert.strictEqual(load({}).compact.mode, 'fixed');
  assert.strictEqual(load({}).compact.threshold, 200000);

  set('compact', 'off');
  assert.strictEqual(load({}).compact.enabled, false);
  assert.strictEqual(load({}).compact.threshold, 200000, 'switching off keeps the threshold');

  set('compact', 'dynamic');
  assert.strictEqual(load({}).compact.mode, 'dynamic');
  assert.strictEqual(load({}).compact.enabled, true);

  set('compact-budget', '$0.25');
  assert.strictEqual(load({}).compact.budgetUsd, 0.25);

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
  assert.throws(() => set('compact', 'sometimes'), /on, off, dynamic or a token count/);
  assert.throws(() => set('compact-budget', 'free'), /dollar amount/);
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

  const fixed = run(['compact', '250000']);
  assert.strictEqual(fixed.status, 0, fixed.stderr);
  assert.match(fixed.stdout, /first prompt at: 250k/);

  const dynamic = run(['compact', 'dynamic']);
  assert.match(dynamic.stdout, /\(dynamic\)/);
  assert.match(dynamic.stdout, /natural break/);

  const bad = run(['compact', 'sometimes']);
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stderr, /usage: rcskills config/);
  c.clean();
});

test('the cache guard is on at $0.50 by default, and settable from file, CLI and env', () => {
  delete process.env.TOKEN_HARNESS_CACHE_GUARD;
  const c = withConfig();
  assert.deepStrictEqual(load({}).cacheGuard, { enabled: true, budgetUsd: 0.5, mode: 'notify' });

  assert.deepStrictEqual(set('cache-guard', '$1.25'), { enabled: true, budgetUsd: 1.25, mode: 'notify' });
  set('compact', 'off');
  assert.deepStrictEqual(load({}).cacheGuard, { enabled: true, budgetUsd: 1.25, mode: 'notify' }, 'other settings keep it');
  assert.strictEqual(/** @type {{mode: string}} */ (/** @type {unknown} */ (set('cache-guard', 'block'))).mode, 'block');
  assert.strictEqual(load({}).cacheGuard.budgetUsd, 1.25, 'switching mode keeps the budget');
  set('cache-guard', 'off');
  assert.strictEqual(load({}).cacheGuard.enabled, false);
  assert.strictEqual(load({}).compact.enabled, false);

  assert.strictEqual(load({ TOKEN_HARNESS_CACHE_GUARD: 'on' }).cacheGuard.enabled, true);
  assert.strictEqual(load({ TOKEN_HARNESS_CACHE_GUARD: '2' }).cacheGuard.budgetUsd, 2);
  assert.strictEqual(load({ TOKEN_HARNESS_CACHE_GUARD: 'block' }).cacheGuard.mode, 'block');
  assert.throws(() => set('cache-guard', 'sometimes'), /on, off, notify, block or a dollar amount/);
  assert.match(describe(load({})), /cache guard:\s+off/);
  c.clean();
});

test('outcome learning is off by default, and set or env turns it on', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-learn-'));
  const env = { TOKEN_HARNESS_CONFIG: path.join(dir, 'config.json') };
  const saved = process.env.TOKEN_HARNESS_CONFIG;
  process.env.TOKEN_HARNESS_CONFIG = env.TOKEN_HARNESS_CONFIG;
  try {
    assert.strictEqual(load(env).learning, false);
    assert.strictEqual(load({ ...env, TOKEN_HARNESS_LEARNING: 'on' }).learning, true);
    set('learning', 'on');
    assert.strictEqual(load(env).learning, true);
    assert.strictEqual(load({ ...env, TOKEN_HARNESS_LEARNING: 'off' }).learning, false, 'env wins');
    assert.throws(() => set('learning', 'maybe'), /on or off/);
    assert.match(describe(load(env)), /outcome learning:   on/);
  } finally {
    if (saved === undefined) delete process.env.TOKEN_HARNESS_CONFIG;
    else process.env.TOKEN_HARNESS_CONFIG = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('model-switch advice is on by default, and set, env and describe all reach it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-switch-'));
  const env = { TOKEN_HARNESS_CONFIG: path.join(dir, 'config.json') };
  const saved = process.env.TOKEN_HARNESS_CONFIG;
  process.env.TOKEN_HARNESS_CONFIG = env.TOKEN_HARNESS_CONFIG;
  try {
    assert.deepEqual(load(env).modelSwitch, { enabled: true, budgetUsd: 0.5 });

    assert.strictEqual(load({ ...env, TOKEN_HARNESS_MODEL_SWITCH: 'off' }).modelSwitch.enabled, false);
    assert.strictEqual(load({ ...env, TOKEN_HARNESS_MODEL_SWITCH: '2.50' }).modelSwitch.budgetUsd, 2.5);
    assert.strictEqual(load({ ...env, TOKEN_HARNESS_MODEL_SWITCH: '$2.50' }).modelSwitch.budgetUsd, 2.5, 'a dollar sign is tolerated');

    set('model-switch', 'off');
    assert.strictEqual(load(env).modelSwitch.enabled, false);
    set('model-switch', '1.25');
    assert.deepEqual(load(env).modelSwitch, { enabled: true, budgetUsd: 1.25 }, 'a budget re-enables it');
    assert.throws(() => set('model-switch', 'sometimes'), /on, off or a dollar amount/);

    assert.match(describe(load(env)), /model switch:       on/);
    assert.match(describe(load(env)), /\$1\.25\+ more than on Sonnet/);
    assert.match(describe(load(env)), /never switches the model for you/);
  } finally {
    if (saved === undefined) delete process.env.TOKEN_HARNESS_CONFIG;
    else process.env.TOKEN_HARNESS_CONFIG = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a damaged modelSwitch block falls back instead of poisoning the advice', () => {
  const c = withConfig('{"modelSwitch":{"budgetUsd":"free","enabled":"yes please"}}');
  try {
    assert.deepEqual(load({}).modelSwitch, { enabled: true, budgetUsd: 0.5 });
  } finally {
    c.clean();
  }
});
