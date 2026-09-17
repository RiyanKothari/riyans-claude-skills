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

test('models people still run are priced, so the cache guard does not go quiet for them', () => {
  // Found 2026-09-17: only 9 models were priced. A Sonnet 4.5, Opus 4.5 or Opus 4.1
  // session got no cache notice, no compaction point and no spend report at all.
  assert.deepStrictEqual(rate('claude-opus-4-5-20251101'), { in: 5, out: 25 });
  assert.deepStrictEqual(rate('claude-opus-4-1-20250805'), { in: 15, out: 75 });
  assert.deepStrictEqual(rate('claude-sonnet-4-5-20250929'), { in: 3, out: 15 });
  assert.deepStrictEqual(rate('claude-sonnet-4-20250514'), { in: 3, out: 15 });
  assert.deepStrictEqual(rate('claude-3-5-haiku-20241022'), { in: 0.8, out: 4 });
  assert.strictEqual(contextWindow('claude-sonnet-4-5-20250929'), 200000);
  assert.strictEqual(contextWindow('claude-sonnet-4-6'), 1000000);
});

test('provider and alias spellings resolve to the same base model', () => {
  const same = {
    'us.anthropic.claude-sonnet-4-5-20250929-v1:0': 'claude-sonnet-4-5',
    'anthropic.claude-opus-4-20250514-v1:0': 'claude-opus-4',
    'arn:aws:bedrock:us-east-1:123456789012:inference-profile/global.anthropic.claude-haiku-4-5-20251001-v1:0': 'claude-haiku-4-5',
    'claude-sonnet-4-5@20250929': 'claude-sonnet-4-5',
    'claude-opus-4-0': 'claude-opus-4',
    'Claude-Sonnet-4-5[1m]': 'claude-sonnet-4-5',
    'claude-3-5-haiku-20241022': 'claude-haiku-3-5',
  };
  for (const [spelled, base] of Object.entries(same)) assert.strictEqual(normalizeModel(spelled), base, spelled);
});

test('a Claude release newer than the table is priced as its family, anything else stays unpriced', () => {
  assert.deepStrictEqual(rate('claude-opus-6'), rate('claude-opus-5'));
  assert.deepStrictEqual(rate('claude-sonnet-5-5-20270101'), rate('claude-sonnet-5'));
  assert.strictEqual(contextWindow('claude-haiku-5'), 200000);
  for (const other of ['<synthetic>', 'haiku', 'gpt-5', 'claude-instant-1', '']) assert.strictEqual(rate(other), null, other);
});
