'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { MemoryStore, tokenize, estimateTokens } = require('./store.cjs');

const DAY = 86400000;
const T0 = 1_700_000_000_000;

function fresh() {
  return new MemoryStore({ path: path.join(os.tmpdir(), `mem-${Math.random()}.jsonl`) });
}

function seeded() {
  const s = fresh();
  s.add({ text: 'the model router maps prompts to haiku sonnet or opus', now: T0 });
  s.add({ text: 'ruflo agentdb schema fails to initialise on windows', now: T0 });
  s.add({ text: 'run npm test to verify the router before shipping', now: T0 });
  return s;
}

test('credentials are redacted at write time', () => {
  const s = fresh();
  // Every value below is synthetic. Never paste a real credential into a
  // fixture — a test file is committed like any other, and a scanner flagging
  // your own tests is indistinguishable from a scanner flagging a real leak.
  const FAKE = 'x'.repeat(24);
  const cases = [
    `key is sk-ant-api03-${FAKE}`,
    `use rzp_test_${'0'.repeat(14)} for payments`,
    `token EAA${FAKE}${FAKE}`,
    'db at postgresql://user:examplepass@host:5432/db',
    `AIza${FAKE}`,
    `ghp_${FAKE}`,
    'api_key = examplevalue1234567890',
    `Authorization: Bearer ${FAKE}.${FAKE}.${FAKE}`,
  ];
  for (const c of cases) {
    const rec = s.add({ text: c, now: T0 });
    assert.match(rec.text, /REDACTED/, `not redacted: ${c.slice(0, 25)}`);
  }
});

test('ordinary text is never mangled by redaction', () => {
  const s = fresh();
  const plain = 'refactor the auth middleware and add tests for the token parser';
  assert.strictEqual(s.add({ text: plain, now: T0 }).text, plain);
});

test('the derived index is never written to disk', () => {
  // Regression: _terms was tokenized pre-redaction and persisted, leaking
  // secrets that the text field no longer contained.
  const s = fresh();
  s.add({ text: 'my key is sk-ant-api03-yyyyyyyyyyyyyyyyyyyyyyyy here', now: T0 });
  s.score('key');
  s.save();

  const raw = fs.readFileSync(s.path, 'utf8');
  assert.ok(!raw.includes('_terms'), 'derived cache must not be persisted');
  assert.ok(!raw.includes('sk-ant-api03-yyyy'), 'secret must not survive anywhere in the file');
  fs.unlinkSync(s.path);
});

test('a reloaded store still searches after the index is dropped', () => {
  const s = fresh();
  s.add({ text: 'router tiers map to models', now: T0 });
  s.save();

  const reloaded = new MemoryStore({ path: s.path }).load();
  assert.strictEqual(reloaded.recall('router tiers', { now: T0 }).records.length, 1);
  fs.unlinkSync(s.path);
});

test('tokenize drops stopwords and stems', () => {
  const t = tokenize('The routers are running tests');
  assert.ok(!t.includes('the'));
  assert.ok(!t.includes('are'));
  assert.ok(t.includes('router'));
  assert.ok(t.includes('run'));
});

test('recall ranks the relevant record first', () => {
  const s = seeded();
  const r = s.recall('which model should route this prompt', { now: T0 });
  assert.ok(r.records.length > 0);
  assert.match(r.records[0].text, /model router/);
});

test('recall never exceeds the token budget', () => {
  const s = seeded();
  const r = s.recall('router windows test', { budgetTokens: 20, now: T0 });
  assert.ok(r.tokensUsed <= 20, `used ${r.tokensUsed}`);
  assert.ok(r.records.length < 3, 'budget must exclude some records');
});

test('a zero budget returns nothing but does not throw', () => {
  const s = seeded();
  const r = s.recall('router', { budgetTokens: 0, now: T0 });
  assert.strictEqual(r.records.length, 0);
  assert.strictEqual(r.tokensUsed, 0);
});

test('unused memories decay, used memories do not', () => {
  const s = fresh();
  const used = s.add({ text: 'alpha router fact', now: T0 });
  const idle = s.add({ text: 'beta unrelated trivia', now: T0 });

  const later = T0 + 60 * DAY;
  s.recall('alpha router', { now: later });

  assert.ok(
    s.effectiveStrength(used, later) > s.effectiveStrength(idle, later),
    'retrieved memory must outrank an idle one',
  );
});

test('retrieval strengthens a record across repeated use', () => {
  const s = fresh();
  const rec = s.add({ text: 'spaced repetition target', now: T0 });
  const before = rec.baseStrength;
  s.recall('spaced repetition', { now: T0 });
  s.recall('spaced repetition', { now: T0 + DAY });
  assert.ok(rec.baseStrength > before);
  assert.strictEqual(rec.uses, 2);
});

test('prune drops cold records and keeps pinned ones', () => {
  const s = fresh();
  s.add({ text: 'cold forgotten note', now: T0 });
  s.add({ text: 'pinned policy that must survive', pinned: true, now: T0 });

  const removed = s.prune({ now: T0 + 400 * DAY });
  assert.strictEqual(removed, 1);
  assert.strictEqual(s.all().length, 1);
  assert.ok(s.all()[0].pinned);
});

test('prune spares young records regardless of strength', () => {
  const s = fresh();
  s.add({ text: 'brand new note', now: T0 });
  assert.strictEqual(s.prune({ now: T0 + DAY }), 0);
});

test('adding the same text twice reinforces instead of duplicating', () => {
  const s = fresh();
  s.add({ text: 'duplicate fact', now: T0 });
  s.add({ text: 'duplicate fact', now: T0 + DAY });
  assert.strictEqual(s.all().length, 1);
  assert.strictEqual(s.all()[0].uses, 1);
});

test('save and load round-trip preserves records', () => {
  const s = seeded();
  s.save();
  const reloaded = new MemoryStore({ path: s.path }).load();
  assert.strictEqual(reloaded.all().length, 3);
  fs.unlinkSync(s.path);
});

test('load survives a corrupt line', () => {
  const p = path.join(os.tmpdir(), `mem-corrupt-${Math.random()}.jsonl`);
  fs.writeFileSync(p, `${JSON.stringify({ text: 'good', tokens: 1, lastUsedAt: T0, createdAt: T0, baseStrength: 1, uses: 0 })}\n{broken\n`);
  const s = new MemoryStore({ path: p }).load();
  assert.strictEqual(s.all().length, 1);
  fs.unlinkSync(p);
});

test('empty query returns no hits', () => {
  assert.strictEqual(seeded().recall('', { now: T0 }).records.length, 0);
});

test('stats report token footprint', () => {
  const st = seeded().stats(T0);
  assert.strictEqual(st.count, 3);
  assert.ok(st.totalTokens > 0);
});

test('estimateTokens scales with length', () => {
  assert.ok(estimateTokens('x'.repeat(400)) > estimateTokens('x'.repeat(40)));
});

test('a stale core record can be replaced', () => {
  // Core is injected into every session, so a wrong record stays wrong forever
  // unless it can be removed.
  const s = fresh();
  s.add({ text: 'gated params cap at three', pinned: true, now: T0 });
  s.add({ text: 'unrelated note', pinned: true, now: T0 });

  s.records = s.all().filter((r) => !r.text.includes('cap at three'));
  s.add({ text: 'gated params cap at four', pinned: true, now: T0 });

  const core = s.coreRecords({ now: T0 }).map((r) => r.text);
  assert.ok(core.includes('gated params cap at four'));
  assert.ok(!core.some((t) => t.includes('cap at three')));
  assert.strictEqual(core.length, 2);
});

test('core always contains pinned policy', () => {
  const s = fresh();
  s.add({ text: 'standing policy', pinned: true, now: T0 });
  s.add({ text: 'ordinary note', now: T0 });
  const core = s.coreRecords({ now: T0 });
  assert.strictEqual(core.length, 1);
  assert.strictEqual(core[0].text, 'standing policy');
});

test('a repeatedly retrieved record earns its way into core', () => {
  const s = fresh();
  s.add({ text: 'earned by repeated use', now: T0 });
  assert.strictEqual(s.coreRecords({ now: T0 }).length, 0);

  for (let i = 0; i < 10; i++) s.recall('earned repeated use', { now: T0 + i * 1000 });

  const core = s.coreRecords({ now: T0 });
  assert.strictEqual(core.length, 1, 'should graduate into core');
  assert.match(core[0].text, /earned/);
});

test('core is bounded by its token budget', () => {
  const s = fresh();
  for (let i = 0; i < 20; i++) {
    s.add({ text: `pinned policy number ${i} with some padding text`, pinned: true, now: T0 });
  }
  const core = s.coreRecords({ now: T0, budgetTokens: 30 });
  const total = core.reduce((a, r) => a + r.tokens, 0);
  assert.ok(total <= 30, `core used ${total} tokens`);
  assert.ok(core.length < 20, 'budget must exclude some records');
});

test('pinned records outrank earned ones in core', () => {
  const s = fresh();
  const earned = s.add({ text: 'earned entry', now: T0 });
  for (let i = 0; i < 10; i++) s.recall('earned entry', { now: T0 + i * 1000 });
  s.add({ text: 'pinned entry', pinned: true, now: T0 });

  const core = s.coreRecords({ now: T0 });
  assert.strictEqual(core[0].text, 'pinned entry');
  assert.ok(core.some((r) => r.id === earned.id));
});
