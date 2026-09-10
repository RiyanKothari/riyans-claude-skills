'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { actualTier, actualScore, tierDelta, classifyTool, TIER_SCORE } = require('./score.cjs');

test('a turn with no tool use at all is trivial', () => {
  assert.strictEqual(actualTier({ edits: 0, commands: 0, reads: 0, distinctFiles: 0 }), 'trivial');
});

test('a single small edit is simple', () => {
  assert.strictEqual(actualTier({ edits: 1, commands: 1, reads: 0, distinctFiles: 1 }), 'simple');
});

test('a few files with moderate effort is moderate', () => {
  assert.strictEqual(actualTier({ edits: 4, commands: 4, reads: 3, distinctFiles: 3 }), 'moderate');
});

test('many files or heavy effort is complex', () => {
  assert.strictEqual(actualTier({ edits: 20, commands: 41, reads: 9, distinctFiles: 13 }), 'complex');
  assert.strictEqual(actualTier({ edits: 2, commands: 27, reads: 4, distinctFiles: 2 }), 'complex');
});

test('a heavy investigation with no edits still counts as work', () => {
  // 25 commands and no file written is debugging, not a chat turn.
  assert.notStrictEqual(actualTier({ edits: 0, commands: 25, reads: 3, distinctFiles: 0 }), 'trivial');
});

test('actualScore maps onto the classifier score bands', () => {
  assert.strictEqual(actualScore({ edits: 0, commands: 0, reads: 0, distinctFiles: 0 }), TIER_SCORE.trivial);
  assert.ok(actualScore({ edits: 30, commands: 30, reads: 5, distinctFiles: 12 }) > 6);
});

test('tierDelta is negative when the prediction was too cheap', () => {
  assert.ok(tierDelta('simple', 'complex') < 0);
  assert.ok(tierDelta('complex', 'simple') > 0);
  assert.strictEqual(tierDelta('moderate', 'moderate'), 0);
});

test('tools are bucketed by their cost signal', () => {
  assert.strictEqual(classifyTool('Edit'), 'edit');
  assert.strictEqual(classifyTool('Write'), 'edit');
  assert.strictEqual(classifyTool('PowerShell'), 'command');
  assert.strictEqual(classifyTool('Bash'), 'command');
  assert.strictEqual(classifyTool('Read'), 'read');
  assert.strictEqual(classifyTool('SomethingElse'), 'other');
});

test('missing fields default safely rather than throwing', () => {
  assert.strictEqual(actualTier({}), 'trivial');
  assert.strictEqual(actualTier({ files: ['a', 'b'] , edits: 2}), 'moderate');
});
