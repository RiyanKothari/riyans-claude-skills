'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { compare, priceOf, PRICING } = require('./cost.cjs');

test('cached tokens cost a fraction of fresh ones', () => {
  const cold = priceOf('claude-opus-5', 100000, 0, 0);
  const warm = priceOf('claude-opus-5', 100000, 0, 100000);
  assert.ok(warm !== null && cold !== null);
  assert.ok(warm < cold / 5, 'a fully cached prefix must be far cheaper');
});

test('delegation wins on a cold expensive context', () => {
  const r = compare({ contextTokens: 60000, cachedTokens: 0, outTokens: 3000 });
  assert.strictEqual(r.winner, 'delegate');
  assert.ok(r.savedPct > 50);
});

test('a warm cache materially shrinks the claimed saving', () => {
  // The old flat model claimed ~93% for this shape. Pricing the parent's
  // cached prefix honestly gives a smaller, truthful number.
  const cold = compare({ contextTokens: 8000, cachedTokens: 0, outTokens: 300, handoffTokens: 4000 });
  const warm = compare({ contextTokens: 8000, cachedTokens: 8000, outTokens: 300, handoffTokens: 4000 });
  assert.ok(warm.savedPct < cold.savedPct, 'caching must reduce the reported saving');
  assert.ok(warm.savedPct < 93, `warm saving ${warm.savedPct}% must undercut the old 93% claim`);
});

test('delegation loses when a huge handoff meets a tiny output', () => {
  // Output price is what usually carries delegation, so it only flips when
  // there is almost no output to save on and the handoff is enormous.
  const r = compare({
    contextTokens: 5000,
    cachedTokens: 5000,
    outTokens: 100,
    handoffTokens: 60000,
  });
  assert.strictEqual(r.winner, 'inline');
  assert.strictEqual(r.savedPct, 0);
});

test('output price is the dominant driver of delegation value', () => {
  const chatty = compare({ contextTokens: 10000, cachedTokens: 10000, outTokens: 8000 });
  const terse = compare({ contextTokens: 10000, cachedTokens: 10000, outTokens: 100 });
  assert.ok(chatty.savedPct > terse.savedPct, 'more output means more to save');
});

test('marginal savings do not count as a win', () => {
  const r = compare({
    sessionModel: 'claude-sonnet-5',
    subModel: 'claude-haiku-4-5-20251001',
    contextTokens: 5000,
    cachedTokens: 4500,
    outTokens: 200,
    handoffTokens: 4000,
    margin: 0.15,
  });
  assert.strictEqual(r.winner, 'inline');
});

test('cacheRatio is reported for transparency', () => {
  const r = compare({ contextTokens: 10000, cachedTokens: 7500 });
  assert.strictEqual(r.cacheRatio, 0.75);
});

test('unknown models degrade to inline rather than guessing', () => {
  const r = compare({ sessionModel: 'nope-1' });
  assert.strictEqual(r.winner, 'inline');
  assert.strictEqual(r.inline, null);
});

test('every priced model has input and output rates', () => {
  for (const [model, p] of Object.entries(PRICING)) {
    assert.ok(p.in > 0, `${model} input rate`);
    assert.ok(p.out > p.in, `${model} output must cost more than input`);
  }
});
