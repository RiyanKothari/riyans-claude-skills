'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { captureSwitch, handoffLine, MAX_AGE_MS, BUDGET_CHARS } = require('./switch-handoff.cjs');

const HANDOFF = {
  prompts: ['build the export', 'now the csv writer'],
  files: ['C:\\repo\\src\\export.js', '/repo/src/csv.js'],
  lastText: 'The writer streams rows; next is quoting.',
  thinking: ['Rows must stream, not buffer: the report can be 2GB.', 'Quote fields containing commas or newlines.'],
  todos: ['Quote fields with commas', 'Add a header row'],
};
const meta = { sessionId: 's1', from: 'claude-opus-5', to: 'claude-sonnet-5', now: 1000 };

test('the reasoning, tasks, asks and files survive the switch as text', () => {
  const line = handoffLine(captureSwitch(HANDOFF, meta), { sessionId: 's1', now: 2000 });
  assert.ok(line);
  assert.match(line, /^\[handoff\] The model changed from claude-opus-5 to claude-sonnet-5/);
  assert.match(line, /Rows must stream, not buffer/);
  assert.match(line, /open tasks: Quote fields with commas; Add a header row/);
  assert.match(line, /working on: "build the export", "now the csv writer"/);
  assert.match(line, /files in flight: src\/export\.js, src\/csv\.js/, 'Windows paths are normalised');
  assert.match(line, /do not redo settled work/);
});

test('it is shown once, only to its own session, and not once it is stale', () => {
  const record = captureSwitch(HANDOFF, meta);
  assert.equal(handoffLine({ ...record, shown: true }, { sessionId: 's1', now: 2000 }), null, 'once');
  assert.equal(handoffLine(record, { sessionId: 's2', now: 2000 }), null, 'another session');
  assert.equal(handoffLine(record, { sessionId: 's1', now: 1000 + MAX_AGE_MS + 1 }), null, 'a cancelled switch does not echo later');
});

test('it stays inside its budget however much there was', () => {
  const huge = { ...HANDOFF, thinking: ['x'.repeat(5000), 'y'.repeat(5000)], lastText: 'z'.repeat(5000), todos: Array(40).fill('t'.repeat(300)) };
  const line = handoffLine(captureSwitch(huge, meta), { sessionId: 's1', now: 2000 });
  assert.ok(line);
  assert.ok(line.length <= BUDGET_CHARS, `line was ${line.length} chars`);
});

test('nothing worth carrying means no handoff at all', () => {
  assert.equal(captureSwitch({ prompts: [], files: ['a.js'], lastText: '', thinking: [], todos: [] }, meta), null);
  assert.equal(captureSwitch(null, meta), null);
  assert.equal(handoffLine(null, { sessionId: 's1' }), null);
});
