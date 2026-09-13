'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { lastContextUsage } = require('./transcript.cjs');

function transcript(lines) {
  const p = path.join(os.tmpdir(), `ctx-${Math.random()}.jsonl`);
  const body = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n');
  fs.writeFileSync(p, `${body}\n`);
  return p;
}

function assistant(usage, model = 'claude-opus-5') {
  return { type: 'assistant', message: { model, usage } };
}

test('context size is fresh input plus cache writes plus cache reads', () => {
  // The exact shape and numbers recorded by a real 725k-token session.
  const p = transcript([assistant({
    input_tokens: 2,
    cache_creation_input_tokens: 192,
    cache_read_input_tokens: 725095,
    output_tokens: 5075,
  })]);
  const u = lastContextUsage(p);
  assert.ok(u);
  assert.strictEqual(u.tokens, 725289, 'output tokens are not part of the context');
  assert.strictEqual(u.model, 'claude-opus-5');
  fs.unlinkSync(p);
});

test('the most recent assistant message wins', () => {
  const p = transcript([
    assistant({ input_tokens: 100, cache_read_input_tokens: 900000 }),
    { type: 'user', message: { content: 'after /compact' } },
    assistant({ input_tokens: 100, cache_read_input_tokens: 40000 }),
  ]);
  const u = lastContextUsage(p);
  assert.ok(u);
  assert.strictEqual(u.tokens, 40100);
  fs.unlinkSync(p);
});

test('corrupt lines and usage outside assistant messages are skipped', () => {
  const p = transcript([
    assistant({ input_tokens: 10, cache_read_input_tokens: 1000 }),
    '{"type":"assistant","message":{"usage":',
    { type: 'system', usage: { input_tokens: 999999 } },
  ]);
  const u = lastContextUsage(p);
  assert.ok(u);
  assert.strictEqual(u.tokens, 1010);
  fs.unlinkSync(p);
});

test('only the tail of a large transcript is read', () => {
  /** @type {any[]} */
  const lines = [assistant({ input_tokens: 1, cache_read_input_tokens: 111 })];
  for (let i = 0; i < 50; i++) lines.push({ type: 'attachment', data: 'x'.repeat(5000) });
  lines.push(assistant({ input_tokens: 1, cache_read_input_tokens: 222 }));

  const p = transcript(lines);
  const u = lastContextUsage(p, 20000);
  assert.ok(u);
  assert.strictEqual(u.tokens, 223);
  fs.unlinkSync(p);
});

test('a transcript with no usage yet returns null', () => {
  const p = transcript([{ type: 'user', message: { content: 'hi' } }]);
  assert.strictEqual(lastContextUsage(p), null);
  fs.unlinkSync(p);
});

test('a missing transcript returns null rather than throwing', () => {
  assert.strictEqual(lastContextUsage(path.join(os.tmpdir(), `nope-${Math.random()}.jsonl`)), null);
});
