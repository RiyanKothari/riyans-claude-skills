'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { recommend, classify, shouldDelegateDown, DELEGATE_MAX_SCORE } = require('./index.cjs');
const { rate } = require('./cost.cjs');

// The rule is measured, so these pin the measured cases rather than a wish list.

test('vague work orders read short but are never delegated', () => {
  // Real prompts rated "simple" that became multi-file work.
  for (const p of ['make it better', 'improve it', 'go', 'Post on my git', 'add a new endpoint for listing invoices']) {
    const r = recommend(p);
    assert.strictEqual(r.delegate, false, `${p} (score ${r.score}) must stay inline`);
    assert.strictEqual(r.direction, null);
  }
});

test('clear mechanical edits delegate down to the pinned haiku subagent', () => {
  for (const p of ['fix a typo in the readme', 'rename the variable foo to bar', 'bump version to 1.2.3']) {
    const r = recommend(p);
    assert.ok(r.score <= DELEGATE_MAX_SCORE, `${p} scored ${r.score}`);
    assert.strictEqual(r.direction, 'down');
    assert.strictEqual(r.delegateTo, 'haiku');
    assert.strictEqual(r.agentType, 'rc-haiku');
  }
});

test('the shipped rule is exactly the score threshold', () => {
  assert.strictEqual(shouldDelegateDown(classify('fix a typo in the readme')), true);
  assert.strictEqual(shouldDelegateDown(classify('improve it')), false);
});

test('a session already on haiku has nothing cheaper to delegate to', () => {
  const r = recommend('fix a typo in the readme', { sessionModel: 'claude-haiku-4-5-20251001' });
  assert.strictEqual(r.direction, null);
  assert.strictEqual(r.savedPct, 0);
});

test('a session on a weaker model hands reasoning-heavy work up to opus', () => {
  const r = recommend('debug this intermittent race condition in the worker pool', { sessionModel: 'claude-sonnet-5' });
  assert.strictEqual(r.direction, 'up');
  assert.strictEqual(r.agentType, 'rc-opus');
});

test('an opus session never escalates and never reports a phantom saving', () => {
  const r = recommend('debug this intermittent race condition in the worker pool', { sessionModel: 'claude-opus-5' });
  assert.strictEqual(r.direction, null);
  assert.strictEqual(r.savedPct, 0);
});

test('older model versions are never cheaper, so nothing routes to them', () => {
  // Opus 4.6-4.8 cost the same as Opus 5; Sonnet 4.6 costs more than Sonnet 5.
  for (const [older, newer] of [
    ['claude-opus-4-8', 'claude-opus-5'],
    ['claude-opus-4-6', 'claude-opus-5'],
    ['claude-sonnet-4-6', 'claude-sonnet-5'],
  ]) {
    const o = rate(older);
    const n = rate(newer);
    if (!o || !n) assert.fail(`${older} and ${newer} must both be priced`);
    assert.ok(o.in >= n.in && o.out >= n.out, `${older} must not undercut ${newer}`);
  }
  for (const sessionModel of ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001']) {
    for (const p of ['fix a typo in the readme', 'refactor the auth architecture across the codebase', 'hello']) {
      const r = recommend(p, { sessionModel });
      assert.ok([null, 'haiku', 'opus'].includes(r.delegateTo), `${p} on ${sessionModel} -> ${r.delegateTo}`);
    }
  }
});
