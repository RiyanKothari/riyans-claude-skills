'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { compare, priceOf, subagentCost, PRICING } = require('./cost.cjs');

test('cached tokens cost a fraction of fresh ones', () => {
  const cold = priceOf('claude-opus-5', 100000, 0, 0);
  const warm = priceOf('claude-opus-5', 100000, 0, 100000);
  assert.ok(warm !== null && cold !== null);
  assert.ok(warm < cold / 5, 'a fully cached prefix must be far cheaper');
});

test('the subagent model reproduces a measured cold haiku run', () => {
  // Two real 3-call haiku subagent runs cost $0.0875 and $0.0883, priced from their transcripts.
  const cost = subagentCost('claude-haiku-4-5', 3);
  if (cost === null) assert.fail('haiku must be priced');
  assert.ok(Math.abs(cost - 0.088) / 0.088 < 0.15, `modelled $${cost.toFixed(4)} vs measured $0.088`);
});

test('a fresh session never repays a haiku subagent', () => {
  const r = compare({ contextTokens: 56000 });
  assert.strictEqual(r.winner, 'inline');
  assert.ok(r.breakEvenTokens !== null && r.breakEvenTokens > 56000, `break-even ${r.breakEvenTokens}`);
});

test('a long opus session does, by a measured-size margin rather than 89%', () => {
  // The session this was built in: 411k context, $0.206 per request just to re-read it.
  const r = compare({ contextTokens: 411000 });
  assert.strictEqual(r.winner, 'delegate');
  assert.ok(r.savedPct > 15 && r.savedPct < 40, `saved ${r.savedPct}%`);
});

test('a warm subagent cache and a longer task both make delegation pay sooner', () => {
  const cold = compare({ contextTokens: 100000 }).breakEvenTokens;
  const warm = compare({ contextTokens: 100000, warmSubagent: true }).breakEvenTokens;
  const longer = compare({ contextTokens: 100000, taskCalls: 4 }).breakEvenTokens;
  if (cold === null || warm === null || longer === null) assert.fail('all three must break even below 1M');
  assert.ok(warm < cold, `warm ${warm} vs cold ${cold}`);
  assert.ok(longer < cold, `4 calls ${longer} vs 2 calls ${cold}`);
});

test('a sonnet session re-reads too cheaply to repay a mechanical delegation', () => {
  assert.strictEqual(compare({ sessionModel: 'claude-sonnet-5', contextTokens: 400000 }).winner, 'inline');
});

test('marginal savings do not count as a win', () => {
  assert.strictEqual(compare({ contextTokens: 400000 }).winner, 'delegate');
  assert.strictEqual(compare({ contextTokens: 400000, margin: 0.99 }).winner, 'inline');
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
