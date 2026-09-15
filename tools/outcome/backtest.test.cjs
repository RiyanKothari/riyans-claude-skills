'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { backtest, formatReport } = require('./backtest.cjs');

const turn = (prompt, edits, commands, reads, distinctFiles) => ({ prompt, edits, commands, reads, distinctFiles });

test('the backtest measures the shipped delegation rule, not the tier', () => {
  const r = backtest([
    turn('make it better', 16, 6, 0, 8), // rated simple, was complex: the old false delegation
    turn('fix a typo in the readme', 1, 0, 1, 1),
  ]);
  assert.strictEqual(r.falseDelegate, 0);
  assert.strictEqual(r.rows[0].predDelegate, false);
  assert.strictEqual(r.rows[1].predDelegate, true);
});

test('turns with no work are reported apart from turns a subagent could take', () => {
  const r = backtest([
    turn('what is the plan', 0, 0, 0, 0),
    turn('fix a typo in the readme', 1, 0, 1, 1),
  ]);
  assert.strictEqual(r.actionable.n, 1);
  assert.strictEqual(r.actionable.precisionPct, 100);
  assert.match(formatReport(r), /turns that edited or ran something: 1/);
});
