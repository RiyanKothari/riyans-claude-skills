'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  PROFILES, HOOK_SPEC, addHooks, removeHooks, readSettings, MARKER,
} = require('../../bin/harness.js');

function tmpSettings(content) {
  const p = path.join(os.tmpdir(), `settings-${Math.random()}.json`);
  fs.writeFileSync(p, content);
  return p;
}

test('every profile maps to known hook modes', () => {
  for (const [name, p] of Object.entries(PROFILES)) {
    for (const mode of p.hooks) {
      assert.ok(HOOK_SPEC[mode], `${name} references unknown mode ${mode}`);
    }
  }
});

test('profiles escalate: minimal < standard < strict', () => {
  assert.ok(PROFILES.minimal.hooks.length < PROFILES.standard.hooks.length);
  assert.ok(PROFILES.standard.hooks.length < PROFILES.strict.hooks.length);
});

test('minimal installs no hooks at all', () => {
  const s = {};
  assert.strictEqual(addHooks(s, PROFILES.minimal.hooks).length, 0);
});

test('install preserves existing user hooks', () => {
  const settings = {
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'my-own-thing' }] }],
    },
  };
  addHooks(settings, PROFILES.standard.hooks);

  const json = JSON.stringify(settings);
  assert.match(json, /my-own-thing/, 'user hook must survive');
  assert.match(json, /learning-hook/, 'our hook must be added');
});

test('installing twice does not duplicate hooks', () => {
  const settings = {};
  const first = addHooks(settings, PROFILES.strict.hooks);
  const second = addHooks(settings, PROFILES.strict.hooks);
  assert.strictEqual(first.length, 3);
  assert.strictEqual(second.length, 0, 'second install should be a no-op');
});

test('uninstall removes only our hooks', () => {
  const settings = {
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'user-hook' }] }],
    },
  };
  addHooks(settings, PROFILES.strict.hooks);
  const removed = removeHooks(settings);

  assert.strictEqual(removed, 3);
  const json = JSON.stringify(settings);
  assert.match(json, /user-hook/, 'user hook must survive uninstall');
  assert.ok(!json.includes(MARKER), 'no harness hooks should remain');
});

test('uninstall on a clean settings file is a safe no-op', () => {
  assert.strictEqual(removeHooks({}), 0);
  assert.strictEqual(removeHooks({ hooks: {} }), 0);
});

test('emptied hook events are cleaned up rather than left as dead keys', () => {
  const settings = {};
  addHooks(settings, ['core']);
  removeHooks(settings);
  assert.strictEqual(settings.hooks.SessionStart, undefined);
});

test('each hook mode targets a distinct lifecycle event', () => {
  const events = Object.values(HOOK_SPEC).map((s) => s.event);
  assert.strictEqual(new Set(events).size, events.length);
});

test('a settings file with a UTF-8 BOM still parses', () => {
  // Regression: the BOM made JSON.parse throw, the reader fell back to {},
  // and install wrote that over the user's entire config.
  const p = tmpSettings('﻿{"model":"claude-opus-5"}');
  const r = readSettings(p);
  assert.ok(r.ok);
  assert.strictEqual(r.value.model, 'claude-opus-5');
  fs.unlinkSync(p);
});

test('an unparseable settings file is reported, never treated as empty', () => {
  const p = tmpSettings('{ this is not json');
  const r = readSettings(p);
  assert.strictEqual(r.ok, false);
  assert.ok(r.existed);
  assert.ok(r.error);
  fs.unlinkSync(p);
});

test('an absent settings file is safe to default', () => {
  const r = readSettings(path.join(os.tmpdir(), `absent-${Math.random()}.json`));
  assert.ok(r.ok);
  assert.strictEqual(r.existed, false);
  assert.deepStrictEqual(r.value, {});
});

test('an empty settings file is safe to default', () => {
  const p = tmpSettings('   \n');
  const r = readSettings(p);
  assert.ok(r.ok);
  assert.deepStrictEqual(r.value, {});
  fs.unlinkSync(p);
});

test('unrelated settings keys survive a hook merge', () => {
  const settings = { model: 'claude-opus-5', env: { FOO: '1' } };
  addHooks(settings, PROFILES.strict.hooks);
  assert.strictEqual(settings.model, 'claude-opus-5');
  assert.deepStrictEqual(settings.env, { FOO: '1' });
});

function commands(settings) {
  return Object.values(settings.hooks || {}).flat().flatMap((g) => g.hooks.map((h) => h.command));
}

test('a global install marks its hooks so they stand down inside the harness repo', () => {
  /** @type {any} */
  const s = {};
  addHooks(s, PROFILES.standard.hooks, { global: true });
  const cmds = commands(s);
  assert.ok(cmds.length > 0);
  assert.ok(cmds.every((c) => c.endsWith(' --global')), cmds.join('\n'));
});

test('a project install does not mark its hooks global', () => {
  /** @type {any} */
  const s = {};
  addHooks(s, PROFILES.standard.hooks);
  assert.ok(commands(s).every((c) => !c.includes('--global')));
});

test('no hook is registered on PostToolUse', () => {
  // It would spawn one process per tool call. This is a load-bearing absence.
  const events = Object.values(HOOK_SPEC).map((s) => s.event);
  assert.ok(!events.includes('PostToolUse'));
});
