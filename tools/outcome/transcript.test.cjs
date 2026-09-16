'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseTranscript, lastTurn, isHumanPrompt } = require('./transcript.cjs');
const { backtest } = require('./backtest.cjs');

function humanLine(promptId, text) {
  return JSON.stringify({
    type: 'user',
    promptId,
    promptSource: 'sdk',
    origin: { kind: 'human' },
    message: { content: text },
    timestamp: '2026-09-07T00:00:00Z',
  });
}

function toolResultLine() {
  return JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result' }] } });
}

function assistantLine(tools) {
  return JSON.stringify({
    type: 'assistant',
    message: { content: tools.map((t) => ({ type: 'tool_use', name: t.name, input: t.input || {} })) },
  });
}

function writeTranscript(lines) {
  const p = path.join(os.tmpdir(), `tr-${Math.random()}.jsonl`);
  fs.writeFileSync(p, `${lines.join('\n')}\n`);
  return p;
}

test('only genuine human turns start a new turn', () => {
  assert.ok(isHumanPrompt(JSON.parse(humanLine('p1', 'hello'))));
  assert.ok(!isHumanPrompt(JSON.parse(toolResultLine())));
  assert.ok(!isHumanPrompt({ type: 'assistant' }));
});

test('tool calls are attributed to the preceding human turn', () => {
  const p = writeTranscript([
    humanLine('p1', 'fix the bug'),
    assistantLine([
      { name: 'Edit', input: { file_path: '/a.js' } },
      { name: 'Edit', input: { file_path: '/b.js' } },
      { name: 'PowerShell' },
    ]),
    toolResultLine(),
    assistantLine([{ name: 'Read' }]),
  ]);

  const turns = parseTranscript(p);
  assert.strictEqual(turns.length, 1);
  assert.strictEqual(turns[0].edits, 2);
  assert.strictEqual(turns[0].commands, 1);
  assert.strictEqual(turns[0].reads, 1);
  assert.strictEqual(turns[0].distinctFiles, 2);
  fs.unlinkSync(p);
});

test('repeated edits to one file count once as a distinct file', () => {
  const p = writeTranscript([
    humanLine('p1', 'edit it twice'),
    assistantLine([
      { name: 'Edit', input: { file_path: '/same.js' } },
      { name: 'Edit', input: { file_path: '/same.js' } },
    ]),
  ]);
  const t = parseTranscript(p)[0];
  assert.strictEqual(t.edits, 2);
  assert.strictEqual(t.distinctFiles, 1);
  fs.unlinkSync(p);
});

test('multiple turns are separated correctly', () => {
  const p = writeTranscript([
    humanLine('p1', 'first task'),
    assistantLine([{ name: 'Edit', input: { file_path: '/a.js' } }]),
    humanLine('p2', 'second task'),
    assistantLine([{ name: 'PowerShell' }]),
  ]);
  const turns = parseTranscript(p);
  assert.strictEqual(turns.length, 2);
  assert.strictEqual(turns[0].edits, 1);
  assert.strictEqual(turns[1].commands, 1);
  assert.strictEqual(turns[1].edits, 0);
  fs.unlinkSync(p);
});

test('a corrupt line does not abort the parse', () => {
  const p = writeTranscript([humanLine('p1', 'ok'), '{not json', assistantLine([{ name: 'Read' }])]);
  assert.strictEqual(parseTranscript(p).length, 1);
  fs.unlinkSync(p);
});

test('a missing transcript yields no turns', () => {
  assert.deepStrictEqual(parseTranscript(path.join(os.tmpdir(), 'nope.jsonl')), []);
});

test('backtest reports the binary delegate decision', () => {
  const turns = [
    { prompt: 'fix a typo in the readme', edits: 1, commands: 0, reads: 0, distinctFiles: 1 },
    { prompt: 'refactor the auth architecture', edits: 20, commands: 20, reads: 8, distinctFiles: 11 },
  ];
  const r = backtest(turns);
  assert.strictEqual(r.n, 2);
  assert.strictEqual(typeof r.binaryCorrectPct, 'number');
  assert.strictEqual(r.falseDelegate + r.missedSaving + r.binaryCorrect, r.n);
});

test('lastTurn returns the most recent turn only', () => {
  const p = writeTranscript([
    humanLine('p1', 'first task'),
    assistantLine([{ name: 'Edit', input: { file_path: '/a.js' } }]),
    humanLine('p2', 'second task'),
    assistantLine([{ name: 'PowerShell' }, { name: 'PowerShell' }]),
  ]);
  const t = lastTurn(p);
  assert.ok(t, 'expected a turn');
  assert.strictEqual(t.prompt, 'second task');
  assert.strictEqual(t.commands, 2);
  assert.strictEqual(t.edits, 0);
  fs.unlinkSync(p);
});

test('lastTurn on an empty or missing transcript is null', () => {
  assert.strictEqual(lastTurn(path.join(os.tmpdir(), 'nope.jsonl')), null);
});

test('tailLines bounds the work on a long transcript', () => {
  const lines = [];
  for (let i = 0; i < 300; i++) {
    lines.push(humanLine(`p${i}`, `task ${i}`));
    lines.push(assistantLine([{ name: 'Read' }]));
  }
  const p = writeTranscript(lines);
  const tailed = parseTranscript(p, { tailLines: 20 });
  assert.ok(tailed.length <= 10, `expected a bounded slice, got ${tailed.length}`);
  assert.strictEqual(parseTranscript(p).length, 300);
  fs.unlinkSync(p);
});

test('backtest counts a cheap prediction on heavy work as a false delegate', () => {
  const r = backtest([
    { prompt: 'fix a typo', edits: 30, commands: 30, reads: 5, distinctFiles: 14 },
  ]);
  assert.strictEqual(r.falseDelegate, 1);
});

test('a long transcript is read from its tail, never whole', () => {
  const p = path.join(os.tmpdir(), `tail-${Math.random()}.jsonl`);
  const pad = { type: 'assistant', message: { model: 'claude-opus-5', content: [{ type: 'text', text: 'x'.repeat(4000) }] } };
  // ~6MB, past the first 4MB chunk, so the chunk has to grow.
  const lines = Array.from({ length: 1500 }, () => JSON.stringify(pad));
  lines.push(JSON.stringify({ type: 'user', promptSource: 'sdk', origin: { kind: 'human' }, message: { content: 'the last ask' } }));
  lines.push(JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/r/a.js' } }] } }));
  fs.writeFileSync(p, `${lines.join('\n')}\n`);

  const whole = parseTranscript(p);
  const tail = parseTranscript(p, { tailLines: 1000 });
  const original = fs.readFileSync;
  /** @type {any} */ (fs).readFileSync = (/** @type {any} */ f, /** @type {any[]} */ ...rest) => {
    if (String(f) === p) throw new Error('read the whole transcript');
    return /** @type {any} */ (original)(f, ...rest);
  };
  try {
    const turn = lastTurn(p);
    assert.ok(turn);
    assert.strictEqual(turn.prompt, 'the last ask');
    assert.strictEqual(turn.edits, whole[whole.length - 1].edits);
    assert.strictEqual(tail.length, 1, 'only the tail was parsed');
  } finally {
    fs.readFileSync = original;
    fs.unlinkSync(p);
  }
});
