'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { adviseCompact, DEFAULT_SETTINGS } = require('./compact.cjs');

const T = DEFAULT_SETTINGS.threshold;
const R = DEFAULT_SETTINGS.remindEvery;

test('silent below the threshold', () => {
  assert.strictEqual(adviseCompact({ tokens: T - 1, sessionId: 's1' }).message, null);
});

test('prompts once context crosses the threshold, and asks Claude to tell the user', () => {
  const r = adviseCompact({ tokens: T + 5000, sessionId: 's1' });
  assert.ok(r.message);
  assert.match(r.message, /\[context\]/);
  assert.match(r.message, /Tell the user/);
  assert.match(r.message, /\/compact/);
  assert.match(r.message, /never mid-implementation/);
  assert.strictEqual(r.state.advisedAt, T + 5000);
});

test('does not nag again until context grows by the remind interval', () => {
  const first = adviseCompact({ tokens: T + 1000, sessionId: 's1' });
  const soon = adviseCompact({ tokens: T + 1000 + R - 1, sessionId: 's1', state: first.state });
  assert.strictEqual(soon.message, null);
  const later = adviseCompact({ tokens: T + 1000 + R, sessionId: 's1', state: soon.state });
  assert.ok(later.message);
});

test('a new session starts with a clean slate', () => {
  const first = adviseCompact({ tokens: T + 1000, sessionId: 's1' });
  assert.ok(adviseCompact({ tokens: T + 2000, sessionId: 's2', state: first.state }).message);
});

test('after /compact shrinks the context, growth is tracked afresh', () => {
  const first = adviseCompact({ tokens: T + 50000, sessionId: 's1' });
  const compacted = adviseCompact({ tokens: 40000, sessionId: 's1', state: first.state });
  assert.strictEqual(compacted.message, null);
  assert.strictEqual(compacted.state.advisedAt, 0);

  const grown = adviseCompact({ tokens: T + 1000, sessionId: 's1', state: compacted.state });
  assert.ok(grown.message, 'prompts again even though this is below the old reminder mark');
});

test('disabled means never', () => {
  assert.strictEqual(
    adviseCompact({ tokens: 900000, sessionId: 's1', settings: { enabled: false } }).message,
    null,
  );
});

test('a custom threshold is honoured', () => {
  assert.strictEqual(adviseCompact({ tokens: 90000, settings: { threshold: 100000 } }).message, null);
  assert.ok(adviseCompact({ tokens: 110000, settings: { threshold: 100000 } }).message);
});

test('costs are shown only when they are known', () => {
  const plain = adviseCompact({ tokens: T + 1 });
  assert.ok(plain.message);
  assert.ok(!plain.message.includes('$'));

  const priced = adviseCompact({ tokens: T + 1, costPerRequestUsd: 1.09, rewriteUsd: 5.85 });
  assert.ok(priced.message);
  assert.match(priced.message, /\$1\.09 per request/);
  assert.match(priced.message, /\$5\.85 to rewrite/);
});

test('a zero or missing token count never prompts', () => {
  assert.strictEqual(adviseCompact({ tokens: 0 }).message, null);
});
