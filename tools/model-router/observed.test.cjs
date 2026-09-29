'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const observed = require('./observed.cjs');

const human = (content) => ({ type: 'user', promptSource: 'sdk', origin: { kind: 'human' }, message: { content } });
const usage = { input_tokens: 0, cache_read_input_tokens: 100000, cache_creation_input_tokens: 0, output_tokens: 2000 };
/** One request: 100k cached reads + 2k output. */
const request = (id, model, tools = []) => ({
  type: 'assistant', requestId: id, message: { model, usage, content: tools.map((t) => ({ type: 'tool_use', ...t })) },
});
const edits = (n) => Array.from({ length: n }, (_, i) => ({ name: 'Edit', input: { file_path: `/r/f${i}.js` } }));

function transcript(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'observed-'));
  const file = path.join(dir, 't.jsonl');
  fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return { dir, file, store: path.join(dir, 'costs.json') };
}

test('each turn is priced on the model that ran it, each request once', () => {
  const t = transcript([
    human('what is this?'), request('a', 'claude-opus-5-5'), request('a', 'claude-opus-5-5'),
    human('rebuild the exporter'), request('b', 'claude-opus-5-5', edits(8)), request('c', 'claude-opus-5-5', edits(4)),
  ]);
  const turns = observed.turnCosts(t.file);
  assert.strictEqual(turns.length, 2);
  // 100k x $0.20/M + 2k x $20/M = $0.06 a request on Opus 5.5.
  assert.strictEqual(turns[0].usd.toFixed(2), '0.06', 'a duplicated request line is counted once');
  assert.deepStrictEqual([turns[1].model, turns[1].requests, turns[1].usd.toFixed(2), turns[1].tier], ['claude-opus-5-5', 2, '0.12', 'complex']);
  fs.rmSync(t.dir, { recursive: true, force: true });
});

test('only complex turns are recorded, once each, and the median decides', () => {
  const t = transcript([]);
  const turns = [
    { id: 'q', model: 'claude-opus-5-5', usd: 0.05, tier: 'trivial' },
    { id: 'x1', model: 'claude-opus-5-5', usd: 2, tier: 'complex' },
    { id: 'x2', model: 'claude-opus-5-5', usd: 3, tier: 'complex' },
    { id: 'x3', model: 'claude-opus-5-5', usd: 90, tier: 'complex' }, // one runaway task
  ];
  assert.strictEqual(observed.record(turns, t.store), 3);
  assert.strictEqual(observed.record(turns, t.store), 0, 'recording twice adds nothing');
  const sum = observed.summarize(observed.load(t.store));
  assert.deepStrictEqual(sum['claude-opus-5-5'], { tasks: 3, usdPerTask: 3, usdPerRequest: null, requestsPerTask: null, paired: null });
  assert.match(observed.formatSummary(sum), /claude-opus-5-5 +\$3\.00 over 3 task\(s\) — 15 needed to count/);
  fs.rmSync(t.dir, { recursive: true, force: true });
});

test('a task costs its price per request times its requests, and old records get their counts', () => {
  const t = transcript([]);
  observed.record([{ id: 'a', model: 'claude-opus-5-5', usd: 3, requests: 0, tier: 'complex' }], t.store);
  assert.strictEqual(observed.record([{ id: 'a', model: 'claude-opus-5-5', usd: 3, requests: 30, tier: 'complex' }], t.store), 1, 'the count is filled in');
  const sum = observed.summarize(observed.load(t.store))['claude-opus-5-5'];
  assert.deepStrictEqual([sum.usdPerRequest, sum.requestsPerTask], [0.1, 30]);
  assert.match(observed.formatSummary({ 'claude-opus-5-5': sum }), /\$3\.00 \(\$0\.100 a request x 30 requests\) over 1 task\(s\)/);
  fs.rmSync(t.dir, { recursive: true, force: true });
});

test('an unreadable or foreign store reads as empty, never throws', () => {
  const t = transcript([]);
  fs.writeFileSync(t.store, '{not json');
  assert.deepStrictEqual(observed.load(t.store), { models: {} });
  assert.strictEqual(observed.formatSummary(observed.summarize(observed.load(t.store))), 'cost per complex task on your sessions: none recorded yet');
  fs.rmSync(t.dir, { recursive: true, force: true });
});

test('tests never touch the real record', () => {
  assert.ok(process.env.NODE_TEST_CONTEXT, 'node --test sets this');
  assert.ok(observed.storePath().startsWith(os.tmpdir()), observed.storePath());
  assert.strictEqual(observed.storePath({ TOKEN_HARNESS_MODEL_COSTS: '/x.json' }), '/x.json');
  assert.ok(observed.storePath({}).endsWith(path.join('.claude', 'token-harness', 'model-costs.json')));
});

test('the Stop hook files the turn that just ended', () => {
  const t = transcript([human('rebuild the exporter'), request('b', 'claude-opus-5-5', edits(8))]);
  const hook = path.join(__dirname, '..', '..', '.claude', 'helpers', 'learning-hook.cjs');
  const r = spawnSync(process.execPath, [hook, 'loop'], {
    input: JSON.stringify({ session_id: 's', transcript_path: t.file }),
    cwd: t.dir,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: t.dir, TOKEN_HARNESS_MODEL_COSTS: t.store, HOME: t.dir, USERPROFILE: t.dir },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(Object.keys(observed.load(t.store).models), ['claude-opus-5-5']);
  fs.rmSync(t.dir, { recursive: true, force: true });
});
