'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { adviseColdCache, afterReplyNotice, adviseModelSwitch, handoffSummary, price } = require('./cache-guard.cjs');

const HOUR = 3600000;
const MIN = 60000;
const NOW = 1_800_000_000_000;

test('re-caching is priced at the cache-write rate, against a fresh 56k session', () => {
  const p = price(500000, 'claude-opus-5', '1h');
  assert.ok(p);
  assert.strictEqual(Number(p.rewriteUsd.toFixed(2)), 5);
  assert.strictEqual(Number(p.freshUsd.toFixed(2)), 0.56);
  assert.strictEqual(Number((price(500000, 'claude-opus-5', '5m') || { rewriteUsd: 0 }).rewriteUsd.toFixed(3)), 3.125);
  assert.strictEqual(price(500000, 'unknown-model', '1h'), null);
});

// ---- after-reply notice (the default) ----

const notice = (over = {}) => afterReplyNotice({
  tokens: 500000, model: 'claude-opus-5', cacheTtl: '1h', now: NOW, sessionId: 's1', state: null, ...over,
});

test('a large session is told after the reply until when the cache is dependable, and what to do', () => {
  const r = notice();
  const until = new Date(NOW + 30 * MIN).toTimeString().slice(0, 5);
  assert.strictEqual(r.message,
    `[cache] 500k tokens cached. Reply before ${until} to keep it cheap; after that your next message can ` +
    're-send it all for ~$5.00. Stepping away? Run /compact first, or /clear (~$0.56 to restart, with a summary ' +
    'of this session).');
  assert.deepStrictEqual(r.state, { sessionId: 's1', at: NOW, tokens: 500000 });
});

test('a 5-minute cache is only promised 5 minutes', () => {
  const until = new Date(NOW + 5 * MIN).toTimeString().slice(0, 5);
  assert.match(String(notice({ cacheTtl: '5m' }).message), new RegExp(`Reply before ${until}`));
});

test('the notice repeats at most every 15 minutes, unless context grew by 100k', () => {
  const first = notice();
  assert.strictEqual(notice({ state: first.state, now: NOW + 10 * MIN }).message, null);
  assert.ok(notice({ state: first.state, now: NOW + 16 * MIN }).message);
  assert.ok(notice({ state: first.state, now: NOW + 10 * MIN, tokens: 600000 }).message);
  assert.ok(notice({ state: { ...first.state, sessionId: 'other' }, now: NOW + MIN }).message);
});

test('small, unpriced or switched-off sessions get no notice', () => {
  // 100k on Opus: $1.00 against $0.56 fresh, under the $0.50 budget.
  assert.strictEqual(notice({ tokens: 100000 }).message, null);
  assert.ok(notice({ tokens: 100000, settings: { budgetUsd: 0.25 } }).message);
  assert.strictEqual(notice({ model: 'unknown' }).message, null);
  assert.strictEqual(notice({ settings: { enabled: false } }).message, null);
  assert.strictEqual(notice({ tokens: 0 }).message, null);
});

// ---- block mode (opt-in) ----

const cold = (over = {}) => adviseColdCache({
  prompt: 'carry on with the report',
  tokens: 500000,
  model: 'claude-opus-5',
  lastResponseAt: NOW - 3 * HOUR,
  cacheTtl: '1h',
  now: NOW,
  sessionId: 's1',
  state: null,
  settings: { mode: 'block' },
  ...over,
});

test('block mode holds the first message into an expired large session, once', () => {
  const r = cold();
  assert.match(String(r.block), /expired 3h 0m ago, so this message would first re-cache 500k tokens on claude-opus-5 \(~\$5\.00\)/);
  assert.strictEqual(cold({ state: r.state }).block, null, 'sending again goes through');
  assert.ok(cold({ state: r.state, lastResponseAt: NOW - 2 * HOUR }).block, 'a new idle period is held again');
});

test('the default notify mode never blocks a message', () => {
  assert.strictEqual(cold({ settings: {} }).block, null);
});

test('block mode stays out of the way when warm, small, a slash command, or off', () => {
  assert.strictEqual(cold({ lastResponseAt: NOW - 50 * MIN }).block, null);
  assert.ok(cold({ cacheTtl: '5m', lastResponseAt: NOW - 10 * MIN }).block);
  assert.strictEqual(cold({ tokens: 100000 }).block, null);
  assert.strictEqual(cold({ prompt: '/clear' }).block, null);
  assert.strictEqual(cold({ prompt: '/compact keep the plan' }).block, null);
  assert.strictEqual(cold({ settings: { mode: 'block', enabled: false } }).block, null);
  assert.strictEqual(cold({ lastResponseAt: 0 }).block, null);
});

// ---- model switch ----

test('re-selecting the model in use asks first, because it only re-caches', () => {
  const reason = adviseModelSwitch({
    from_model: 'claude-opus-5', to_model: 'claude-opus-5', prompt_cache_warm: true,
    context_tokens: 347000, estimated_cache_write_usd: 3.47,
  });
  assert.strictEqual(reason,
    '[cache] Already on claude-opus-5: this changes nothing but re-caches 347k tokens (~$3.47). ' +
    'Confirm only if you meant to change something else.');
  assert.match(String(adviseModelSwitch({
    from_model: 'claude-haiku-4-5-20251001', to_model: 'claude-haiku-4-5', context_tokens: 100000,
  })), /~\$0\.20/);
});

test('a real switch, a cold cache or an empty session is left to Claude Code', () => {
  const base = { from_model: 'claude-opus-5', to_model: 'claude-sonnet-5', prompt_cache_warm: true, context_tokens: 300000 };
  assert.strictEqual(adviseModelSwitch(base), null);
  assert.strictEqual(adviseModelSwitch({ ...base, to_model: 'claude-opus-5', prompt_cache_warm: false }), null);
  assert.strictEqual(adviseModelSwitch({ ...base, to_model: 'claude-opus-5', context_tokens: 0 }), null);
  assert.strictEqual(adviseModelSwitch({}), null);
});

test('the handoff names recent asks, edited files and the last reply, clipped', () => {
  const s = String(handoffSummary({
    prompts: ['fix the login bug', 'x'.repeat(400)],
    files: ['C:\\repo\\src\\auth\\login.ts', ...Array.from({ length: 9 }, (_, i) => `/r/f${i}.js`)],
    lastText: 'Fixed and pushed.\n\nAll tests pass.',
  }));
  assert.match(s, /recent asks: "fix the login bug", "x{139}…"/);
  assert.match(s, /files edited: auth\/login\.ts, r\/f0\.js/);
  assert.match(s, /\+2;/);
  assert.match(s, /last reply: "Fixed and pushed\. All tests pass\."/);
  assert.strictEqual(handoffSummary({ prompts: [], files: [], lastText: '' }), null);
  assert.strictEqual(handoffSummary(null), null);
});
