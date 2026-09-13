'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { adviseCompact, computeThreshold } = require('./compact.cjs');

const FIXED = { mode: 'fixed', threshold: 160000, remindEvery: 100000 };
const T = FIXED.threshold;
const R = FIXED.remindEvery;

// --- behaviour shared by both modes, exercised in fixed mode for exact numbers ---

test('silent below the prompt point', () => {
  assert.strictEqual(adviseCompact({ tokens: T - 1, sessionId: 's1', settings: FIXED }).message, null);
});

test('prompts past the prompt point, and asks Claude to tell the user', () => {
  const r = adviseCompact({ tokens: T + 5000, sessionId: 's1', settings: FIXED });
  assert.ok(r.message);
  assert.match(r.message, /\[context\]/);
  assert.match(r.message, /Tell the user/);
  assert.match(r.message, /\/compact/);
  assert.match(r.message, /never mid-implementation/);
  assert.strictEqual(r.state.advisedAt, T + 5000);
});

test('does not nag again until context grows by the remind interval', () => {
  const first = adviseCompact({ tokens: T + 1000, sessionId: 's1', settings: FIXED });
  const soon = adviseCompact({ tokens: T + 1000 + R - 1, sessionId: 's1', state: first.state, settings: FIXED });
  assert.strictEqual(soon.message, null);
  const later = adviseCompact({ tokens: T + 1000 + R, sessionId: 's1', state: soon.state, settings: FIXED });
  assert.ok(later.message);
});

test('a new session starts with a clean slate', () => {
  const first = adviseCompact({ tokens: T + 1000, sessionId: 's1', settings: FIXED });
  assert.ok(adviseCompact({ tokens: T + 2000, sessionId: 's2', state: first.state, settings: FIXED }).message);
});

test('after /compact shrinks the context, growth is tracked afresh', () => {
  const first = adviseCompact({ tokens: T + 50000, sessionId: 's1', settings: FIXED });
  const compacted = adviseCompact({ tokens: 40000, sessionId: 's1', state: first.state, settings: FIXED });
  assert.strictEqual(compacted.message, null);
  assert.strictEqual(compacted.state.advisedAt, 0);
  assert.deepStrictEqual(compacted.state.samples, [40000], 'growth history resets too');

  const grown = adviseCompact({ tokens: T + 1000, sessionId: 's1', state: compacted.state, settings: FIXED });
  assert.ok(grown.message, 'prompts again even though this is below the old reminder mark');
});

test('disabled means never', () => {
  assert.strictEqual(adviseCompact({ tokens: 900000, settings: { enabled: false } }).message, null);
});

test('costs are shown only when they are known', () => {
  const plain = adviseCompact({ tokens: T + 1, settings: FIXED });
  assert.ok(plain.message);
  assert.ok(!plain.message.includes('$'));

  const priced = adviseCompact({ tokens: T + 1, settings: FIXED, costPerRequestUsd: 1.09, rewriteUsd: 5.85 });
  assert.ok(priced.message);
  assert.match(priced.message, /\$1\.09 per request/);
  assert.match(priced.message, /\$5\.85 to rewrite/);
});

test('a zero token count never prompts', () => {
  assert.strictEqual(adviseCompact({ tokens: 0 }).message, null);
});

// --- dynamic mode ---

test('dynamic is the default', () => {
  const { reasons } = computeThreshold({ tokens: 100000, model: 'claude-opus-5' });
  assert.ok(!reasons.includes('fixed threshold'));
});

test('the budget sets the prompt point on a priced model', () => {
  // Opus 5 re-reads cached context at $0.50 per million tokens: $0.15 buys 300k.
  assert.strictEqual(computeThreshold({ tokens: 1, model: 'claude-opus-5' }).threshold, 300000);
});

test('an expensive model is prompted sooner than a cheaper one', () => {
  const opus = computeThreshold({ tokens: 1, model: 'claude-opus-5' }).threshold;
  const sonnet = computeThreshold({ tokens: 1, model: 'claude-sonnet-5' }).threshold;
  assert.ok(opus < sonnet, `opus ${opus} should come before sonnet ${sonnet}`);
});

test('a small context window caps the prompt point', () => {
  // Haiku 4.5 has a 200K window, so the quality share (40%) binds before cost does.
  assert.strictEqual(computeThreshold({ tokens: 1, model: 'claude-haiku-4-5-20251001' }).threshold, 80000);
});

test('a natural break brings the prompt forward and mid-task pushes it back', () => {
  const at = (phase) => computeThreshold({ tokens: 1, model: 'claude-opus-5', phase }).threshold;
  assert.ok(at('boundary') < at('unknown'));
  assert.ok(at('working') > at('unknown'));
});

test('fast growth brings the prompt forward, slow growth pushes it back', () => {
  const at = (growthPerPrompt) => computeThreshold({ tokens: 1, model: 'claude-opus-5', growthPerPrompt }).threshold;
  assert.ok(at(60000) < at(0));
  assert.ok(at(5000) > at(0));
});

test('an unknown model falls back to a share of a presumed window', () => {
  const r = computeThreshold({ tokens: 300000, model: 'some-other-model' });
  assert.strictEqual(r.threshold, 400000);
  assert.match(r.reasons.join(' '), /presumed/);
});

test('the prompt point never leaves the window', () => {
  const r = computeThreshold({
    tokens: 1,
    model: 'claude-sonnet-5',
    phase: 'working',
    growthPerPrompt: 1000,
    settings: { budgetUsd: 100, qualityShare: 0.9 },
  });
  assert.ok(r.threshold <= 800000, `got ${r.threshold}`);
});

test('growth is measured across prompts in the same session', () => {
  /** @type {any} */
  let state = null;
  for (const tokens of [100000, 160000, 220000]) {
    ({ state } = adviseCompact({ tokens, sessionId: 's', model: 'claude-opus-5', state }));
  }
  assert.deepStrictEqual(state.samples, [100000, 160000, 220000]);
});

test('the message says where the prompt point is and why', () => {
  const r = adviseCompact({ tokens: 500000, sessionId: 's', model: 'claude-opus-5' });
  assert.ok(r.message);
  assert.match(r.message, /prompt point 300k/);
  assert.match(r.message, /\$0\.15\/request on claude-opus-5/);
  assert.match(r.message, /\$0\.25 per request to re-read/);
});
