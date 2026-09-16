'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { adviseColdCache, handoffSummary } = require('./cache-guard.cjs');

const HOUR = 3600000;
const NOW = 1_800_000_000_000;

const cold = (over = {}) => adviseColdCache({
  prompt: 'carry on with the report',
  tokens: 500000,
  model: 'claude-opus-5',
  lastResponseAt: NOW - 3 * HOUR,
  cacheTtl: '1h',
  now: NOW,
  sessionId: 's1',
  state: null,
  ...over,
});

test('a large session idle past its cache lifetime is held once, with the price', () => {
  const r = cold();
  assert.ok(r.block);
  // 500k tokens re-cached at 2x Opus input ($10/M) is $5; a fresh session is ~56k.
  assert.strictEqual(Number(r.rewriteUsd.toFixed(2)), 5);
  assert.strictEqual(Number(r.freshUsd.toFixed(2)), 0.56);
  assert.match(r.block, /expired 3h 0m ago/);
  assert.match(r.block, /500k tokens on claude-opus-5 \(~\$5\.00\)/);
  assert.match(r.block, /\/clear starts fresh for ~\$0\.56/);
  assert.match(r.block, /Send the message again/);
  assert.deepStrictEqual(r.state, { sessionId: 's1', lastResponseAt: NOW - 3 * HOUR });
});

test('sending again after the hold goes through', () => {
  const first = cold();
  assert.strictEqual(cold({ state: first.state }).block, null);
});

test('a new idle period after that is held again', () => {
  const first = cold();
  const later = cold({ state: first.state, lastResponseAt: NOW - 2 * HOUR });
  assert.ok(later.block);
});

test('a warm cache is never held', () => {
  assert.strictEqual(cold({ lastResponseAt: NOW - 50 * 60000 }).block, null);
});

test('a 5-minute cache expires after 5 minutes, and re-caches at 1.25x', () => {
  const r = cold({ cacheTtl: '5m', lastResponseAt: NOW - 10 * 60000 });
  assert.ok(r.block);
  assert.strictEqual(Number(r.rewriteUsd.toFixed(3)), 3.125);
  assert.match(r.block, /5-minute prompt cache expired 10m ago/);
});

test('a session small enough that a fresh one saves little is not held', () => {
  // 100k on Opus: $1.00 to re-cache against $0.56 fresh, under the $0.50 budget.
  assert.strictEqual(cold({ tokens: 100000 }).block, null);
  assert.ok(cold({ tokens: 100000, settings: { budgetUsd: 0.25 } }).block);
});

test('slash commands are never held: /clear and /compact are the way out', () => {
  assert.strictEqual(cold({ prompt: '/clear' }).block, null);
  assert.strictEqual(cold({ prompt: '/compact keep the plan' }).block, null);
});

test('the guard stays out of the way when off, unpriced, or missing data', () => {
  assert.strictEqual(cold({ settings: { enabled: false } }).block, null);
  assert.strictEqual(cold({ model: 'some-unknown-model' }).block, null);
  assert.strictEqual(cold({ lastResponseAt: 0 }).block, null);
  assert.strictEqual(cold({ tokens: 0 }).block, null);
  assert.strictEqual(cold({ prompt: '   ' }).block, null);
});

test('the handoff names recent asks, edited files and the last reply, clipped', () => {
  const s = String(handoffSummary({
    prompts: ['fix the login bug', 'x'.repeat(400)],
    files: ['C:\\repo\\src\\auth\\login.ts', ...Array.from({ length: 9 }, (_, i) => `/r/f${i}.js`)],
    lastText: 'Fixed and pushed.\n\nAll tests pass.',
  }));
  assert.match(s, /recent asks: "fix the login bug", "x{139}…"/);
  assert.match(s, /files edited: auth\/login\.ts, r\/f0\.js/);
  assert.match(s, /\+2$|\+2;/);
  assert.match(s, /last reply: "Fixed and pushed\. All tests pass\."/);
  assert.strictEqual(handoffSummary({ prompts: [], files: [], lastText: '' }), null);
  assert.strictEqual(handoffSummary(null), null);
});
