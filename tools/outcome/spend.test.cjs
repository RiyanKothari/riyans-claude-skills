'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { analyzeRecords, formatReport } = require('./spend.cjs');

const T0 = Date.parse('2026-09-16T10:00:00Z');
const MIN = 60000;
let seq = 0;

/** @param {number} at @param {{model?: string, read?: number, write?: number, out?: number, ttl?: string, content?: object[]}} [o] */
function req(at, { model = 'claude-opus-5', read = 0, write = 0, out = 100, ttl = '1h', content } = {}) {
  seq++;
  return {
    type: 'assistant',
    requestId: `req-${seq}`,
    timestamp: new Date(T0 + at).toISOString(),
    message: {
      model,
      content: content || [{ type: 'text', text: 'ok' }],
      usage: {
        input_tokens: 0,
        cache_read_input_tokens: read,
        cache_creation_input_tokens: write,
        cache_creation: ttl === '1h'
          ? { ephemeral_1h_input_tokens: write, ephemeral_5m_input_tokens: 0 }
          : { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: write },
        output_tokens: out,
      },
    },
  };
}

test('requests are priced once each, even when a response spans several records', () => {
  const a = req(0, { write: 1000000, out: 0 });
  const r = analyzeRecords([a, { ...a }]);
  assert.strictEqual(r.requests, 1);
  // 1M tokens written to a 1-hour cache on Opus: 2x $5.
  assert.strictEqual(Number(r.usd.write.toFixed(2)), 10);
});

test('a cache rewritten after an idle gap is counted as expired and guardable', () => {
  const r = analyzeRecords([
    req(0, { write: 400000 }),
    req(2 * MIN, { read: 400000 }),
    req(3 * 60 * MIN, { write: 400000 }),
  ]);
  assert.strictEqual(r.rewrites.expired.n, 1);
  assert.strictEqual(Number(r.rewrites.expired.usd.toFixed(2)), 4);
  assert.strictEqual(r.avoidable.n, 1);
  // $4.00 rewrite less a ~$0.56 fresh session.
  assert.strictEqual(Number(r.avoidable.usd.toFixed(2)), 3.44);
});

test('a large new tool result is growth, not a rewrite', () => {
  const r = analyzeRecords([
    req(0, { write: 40000 }),
    req(MIN, { read: 40000, write: 580000 }),
  ]);
  const total = Object.values(r.rewrites).reduce((n, v) => n + v.n, 0);
  assert.strictEqual(total, 0);
});

test('model switches and compactions are told apart from expiry', () => {
  const r = analyzeRecords([
    req(0, { write: 300000 }),
    req(MIN, { model: 'claude-sonnet-5', write: 300000 }),
    { type: 'system', subtype: 'compact_boundary' },
    req(2 * MIN, { model: 'claude-sonnet-5', write: 40000 }),
  ]);
  assert.strictEqual(r.rewrites.modelSwitch.n, 1);
  assert.strictEqual(r.rewrites.compaction.n, 1);
  assert.strictEqual(r.rewrites.expired.n, 0);
});

test('a 1-hour cache rewritten after 30-60 idle minutes is its own, avoidable cause', () => {
  const r = analyzeRecords([req(0, { write: 400000 }), req(40 * MIN, { write: 400000 })]);
  assert.strictEqual(r.rewrites.lateInHour.n, 1);
  assert.strictEqual(r.rewrites.expired.n, 0);
  assert.strictEqual(r.avoidable.n, 1);
});

test('a /model command that re-selects the same model is named as the cause', () => {
  const r = analyzeRecords([
    req(0, { write: 350000 }),
    { type: 'user', message: { content: '<command-name>/model</command-name> <command-args>claude-opus-5</command-args>' } },
    req(MIN, { write: 350000 }),
  ]);
  assert.strictEqual(r.rewrites.modelCommand.n, 1);
  assert.strictEqual(r.rewrites.other.n, 0);
});

test('a 5-minute cache counts as expired after 5 minutes', () => {
  const r = analyzeRecords([
    req(0, { write: 200000, ttl: '5m' }),
    req(10 * MIN, { write: 200000, ttl: '5m' }),
  ]);
  assert.strictEqual(r.rewrites.expired.n, 1);
});

test('content is priced for every later request that re-reads it, until compaction', () => {
  const big = 'x'.repeat(40000); // ~10k tokens
  const r = analyzeRecords([
    req(0, { write: 60000, content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] }),
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: big }] } },
    req(MIN, { read: 70000 }),
    req(2 * MIN, { read: 70000 }),
    { type: 'system', subtype: 'compact_boundary' },
    req(3 * MIN, { write: 20000 }),
  ]);
  const c = r.content['result:Bash'];
  assert.strictEqual(c.tokens, 10000);
  // Re-read by two requests at $0.50/M before the compaction.
  assert.strictEqual(Number(c.usd.toFixed(4)), 0.01);
  assert.strictEqual(r.largeOutputs.n, 1);
});

test('only rendered attachments count as context', () => {
  const r = analyzeRecords([
    req(0, { write: 60000 }),
    { type: 'attachment', attachment: { type: 'prompt_snapshot' } },
    { type: 'attachment', attachment: { type: 'hook_additional_context', hookEvent: 'UserPromptSubmit' }, rendered: [{ content: 'note' }] },
    req(MIN, { read: 60000 }),
  ]);
  assert.ok(r.content['hook:UserPromptSubmit']);
  assert.strictEqual(r.content['attachment:prompt_snapshot'], undefined);
});

test('the report explains each rewrite cause and the guard saving', () => {
  const r = analyzeRecords([req(0, { write: 400000 }), req(3 * 60 * MIN, { write: 400000 })]);
  const text = formatReport(r);
  assert.match(text, /1 session file\(s\), 2 requests/);
  assert.match(text, /cache expired while idle/);
  assert.match(text, /1 idle rewrites cost \$0\.50\+ over a fresh session: \/compact or \/clear before stepping away saves \$3\.44/);
});
