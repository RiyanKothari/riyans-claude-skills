'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { analyzeRecords, classifyRewrites, formatReport, formatSummary } = require('./spend.cjs');

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

test('an effort change that re-sends cached context is named, with both levels', () => {
  const records = [
    { ...req(0, { write: 300000 }), effort: 'high' },
    { ...req(MIN, { read: 300000 }), effort: 'high' },
    { ...req(2 * MIN, { write: 300000 }), effort: 'max' },
  ];
  const events = classifyRewrites(records);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].cause, 'effortChange');
  assert.strictEqual(events[0].fromEffort, 'high');
  assert.strictEqual(events[0].toEffort, 'max');
  assert.strictEqual(events[0].tokens, 300000);
  assert.strictEqual(analyzeRecords(records).rewrites.effortChange.n, 1);
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

test('the summary says in words what was avoidable, and invites only first-time npx runs', () => {
  const r = analyzeRecords([req(0, { write: 400000 }), req(3 * 60 * MIN, { write: 400000 })]);
  const text = formatSummary(r);
  assert.match(text, /Nothing is sent anywhere/);
  assert.match(text, /\$3\.44 \(\d+\.\d%\) re-sent a whole cached session after a break, once./);
  assert.match(text, /Pro or Max plan/);
  assert.doesNotMatch(text, /plugin install/);
  assert.match(formatSummary(r, { invite: true }), /claude plugin install rcskills@riyans-claude-skills/);

  const calm = formatSummary(analyzeRecords([req(0, { write: 60000 }), req(MIN, { read: 60000 })]));
  assert.match(calm, /nothing avoidable there/);
});

test('run with no transcripts, it names the folder it looked in and how to point it elsewhere', () => {
  const { execFileSync } = require('node:child_process');
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'spend-empty-'));
  try {
    const out = execFileSync(process.execPath, [path.join(__dirname, 'spend.cjs')], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: empty }, encoding: 'utf8',
    });
    assert.ok(out.includes(path.join(empty, 'projects')), out);
    assert.match(out, /set CLAUDE_CONFIG_DIR/);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('the summary counts one session and one break in words', () => {
  const text = formatSummary(analyzeRecords([req(0, { write: 400000 }), req(3 * 60 * MIN, { write: 400000 })]));
  assert.match(text, / 1 session, 2 requests: /);
  assert.match(text, /after a break, once\./);
});

test('a damaged transcript still produces a number, never $NaN', () => {
  // The first thing a stranger runs is `npx … spend`. One malformed usage field
  // used to print "$NaN at API list price" across the whole headline.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spend-junk-'));
  fs.mkdirSync(path.join(dir, 'projects', 'p'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'projects', 'p', 's.jsonl'), [
    'not json at all',
    '{"type":"assistant"}',
    JSON.stringify({ type: 'assistant', requestId: 'a', timestamp: '2026-09-16T10:00:00Z', message: { model: 'claude-opus-5', usage: { input_tokens: 'lots', cache_read_input_tokens: null, output_tokens: 5 } } }),
    JSON.stringify({ type: 'assistant', requestId: 'b', timestamp: 'bogus', message: { model: 'claude-opus-5', usage: { input_tokens: 10, cache_creation_input_tokens: 400000, cache_creation: { ephemeral_1h_input_tokens: 400000 }, output_tokens: 5 } } }),
  ].join('\n') + '\n');

  const out = spawnSync(process.execPath, [path.join(__dirname, 'spend.cjs')], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
  }).stdout;
  assert.doesNotMatch(out, /NaN/, out);
  assert.match(out, /\$4\.00 at API list price/, out);
  fs.rmSync(dir, { recursive: true, force: true });
});
