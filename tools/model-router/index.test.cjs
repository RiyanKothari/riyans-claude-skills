'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { classify, recommend, estimateCost, TIER_MODEL } = require('./index.cjs');

test('trivial edits route to haiku', () => {
  for (const p of [
    'fix a typo in the readme',
    'rename the variable foo to bar',
    'remove console.log from utils.js',
    'bump version to 1.2.3',
  ]) {
    const r = recommend(p);
    assert.strictEqual(r.agentModel, 'haiku', `${p} -> ${r.tier}`);
    assert.ok(r.delegate, `${p} should be delegatable`);
  }
});

test('deep engineering routes to opus', () => {
  for (const p of [
    'refactor the auth architecture across the codebase',
    'debug this intermittent race condition in the worker pool',
    'design the migration strategy for the new schema',
  ]) {
    const r = recommend(p);
    assert.strictEqual(r.tier, 'complex', `${p} -> ${r.tier}`);
    assert.strictEqual(r.model, 'claude-opus-5');
  }
});

test('reasoning questions never route to haiku', () => {
  for (const p of [
    'why does this test fail only in CI?',
    'how should we structure the payment module?',
    'what is the best approach here, and should we split it?',
  ]) {
    const r = recommend(p);
    assert.notStrictEqual(r.agentModel, 'haiku', `${p} -> ${r.tier}`);
  }
});

test('explicit escalation words force a high tier', () => {
  const plain = classify('rename the variable');
  const escalated = classify('rename the variable carefully, this is production');
  assert.ok(
    escalated.score > plain.score,
    'escalation words must raise the score',
  );
  // The safety property is that caution words keep a task off the weakest
  // model — not that every cautious task deserves opus.
  const r = recommend('rename the variable carefully, this is production');
  assert.notStrictEqual(r.agentModel, 'haiku');
  assert.ok(!r.delegate);
});

test('an ambiguous prompt WITH complexity evidence escalates', () => {
  // Evidence present but the score lands near a boundary: move up, never down.
  const r = classify('rename it across the codebase');
  assert.ok(r.matched.some((m) => m.weight > 0), 'test needs a positive signal');
  if (r.escalated) assert.ok(r.confidence < 0.34);
  assert.notStrictEqual(r.tier, 'trivial');
});

test('a short prompt with NO complexity evidence is not escalated', () => {
  // Backtest finding: escalating these collapsed the trivial tier into
  // moderate and caused 54.7% over-routing. Absence of evidence is not
  // ambiguity.
  const r = classify('update the label');
  assert.strictEqual(r.escalated, false);
  assert.ok(['trivial', 'simple'].includes(r.tier), `got ${r.tier}`);
});

test('a short OPEN-ENDED work order is still escalated', () => {
  // The dangerous twin of the case above: equally short, unbounded scope.
  const r = classify('go on, start working');
  assert.ok(['moderate', 'complex'].includes(r.tier), `got ${r.tier}`);
});

test('empty prompt defaults to moderate', () => {
  const r = classify('');
  assert.strictEqual(r.tier, 'moderate');
  assert.strictEqual(r.confidence, 0);
});

test('multi-item lists raise the tier', () => {
  const single = classify('add a field to the form');
  const list = classify('add a field to the form\n- wire it to the API\n- add validation\n- write tests');
  assert.ok(list.score > single.score);
});

test('cost estimate is cheaper for haiku than opus', () => {
  const haiku = estimateCost('claude-haiku-4-5-20251001', 15000, 2000);
  const opus = estimateCost('claude-opus-5', 15000, 2000);
  assert.ok(haiku !== null);
  assert.ok(opus !== null);
  assert.ok(haiku < opus);
  assert.ok(haiku > 0);
});

test('unknown model returns null cost', () => {
  assert.strictEqual(estimateCost('not-a-model', 1000, 1000), null);
});

test('recommend reports real savings against the opus baseline', () => {
  const r = recommend('fix a typo in the readme');
  assert.ok(r.savedUsd > 0);
  assert.ok(r.savedPct > 50, `expected >50% saving, got ${r.savedPct}`);
  assert.strictEqual(r.baselineCostUsd, estimateCost('claude-opus-5', 15000, 2000));
});

test('every tier maps to a priced model', () => {
  for (const model of Object.values(TIER_MODEL)) {
    const cost = estimateCost(model, 1000, 1000);
    assert.ok(cost !== null, `${model} must be priced`);
    assert.ok(cost > 0, `${model} must have a positive price`);
  }
});

test('word boundaries prevent false matches', () => {
  // "approach" is a reasoning token; "approaching" must not trigger it.
  const r = classify('the approaching deadline');
  assert.ok(!r.matched.some((m) => m.signal === 'reasoning'));
});

test('repo blast radius lifts a prompt that reads trivial', () => {
  const plain = classify('fix a typo in core.js');
  const hot = classify('fix a typo in core.js', { repoScore: 4 });
  assert.strictEqual(plain.tier, 'trivial');
  assert.notStrictEqual(hot.tier, 'trivial');
  assert.ok(hot.matched.some((m) => m.signal === 'repo-blast-radius'));
});

test('observed neighbours pull a misread prompt toward reality', () => {
  const neighbors = [
    { actualScore: 9, similarity: 0.9 },
    { actualScore: 8, similarity: 0.8 },
  ];
  const plain = classify('rename the helper');
  const learned = classify('rename the helper', { neighbors });
  assert.ok(learned.score > plain.score);
  assert.ok(learned.matched.some((m) => m.signal.startsWith('observed-neighbors')));
});

test('a single neighbour is ignored as noise', () => {
  const one = classify('rename the helper', { neighbors: [{ actualScore: 9, similarity: 0.9 }] });
  assert.deepStrictEqual(one.score, classify('rename the helper').score);
});

test('malformed neighbours are discarded safely', () => {
  const bad = classify('rename the helper', {
    neighbors: [null, { actualScore: 'x' }, { similarity: 1 }],
  });
  assert.deepStrictEqual(bad.score, classify('rename the helper').score);
});

test('recommend derives repo score from a real repo root', () => {
  const r = recommend('fix a typo in index.cjs', { repoRoot: __dirname });
  assert.strictEqual(typeof r.repoScore, 'number');
  assert.ok(r.repoScore >= 0);
});
