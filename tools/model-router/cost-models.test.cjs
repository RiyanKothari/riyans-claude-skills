'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { rate, cacheReadRate, contextWindow, normalizeModel, priceOf } = require('./cost.cjs');

test('list prices match the published rates', () => {
  // Regression: the first table was written from memory and priced Opus 5 at
  // $15/$75, three times too high, which inflated every cost this harness reported.
  assert.deepStrictEqual(rate('claude-opus-5'), { in: 5, out: 25 });
  assert.deepStrictEqual(rate('claude-sonnet-5'), { in: 2, out: 10 });
  assert.deepStrictEqual(rate('claude-haiku-4-5'), { in: 1, out: 5 });
});

test('dated model ids are priced by their base id', () => {
  assert.strictEqual(normalizeModel('claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
  assert.deepStrictEqual(rate('claude-haiku-4-5-20251001'), rate('claude-haiku-4-5'));
});

test('cache reads are a tenth of input, except where priced separately', () => {
  assert.strictEqual(cacheReadRate('claude-opus-5'), 0.5);
  assert.strictEqual(cacheReadRate('claude-fable-5-1'), 0.25);
  assert.strictEqual(cacheReadRate('not-a-model'), null);
});

test('a cached prefix is priced at the model\'s own cache-read rate', () => {
  // Fable 5.1 reads cache at $0.25, not 0.1 x $10.
  assert.strictEqual(priceOf('claude-fable-5-1', 1e6, 0, 1e6), 0.25);
});

test('context windows come from the model', () => {
  assert.strictEqual(contextWindow('claude-haiku-4-5'), 200000);
  assert.strictEqual(contextWindow('claude-opus-5'), 1000000);
  assert.strictEqual(contextWindow('mystery-model'), null);
});
