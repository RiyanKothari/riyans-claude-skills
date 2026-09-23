'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  adviseSessionSwitch, switchEconomics, MEDIAN_TURN_REQUESTS, REARM_GROWTH,
} = require('./session-switch.cjs');

const OPUS = 'claude-opus-5';
// Above the point where a median turn saves the default $0.50 budget: the saving
// is tokens * $0.30/Mtok * 22 requests, so the line starts at ~76k of context.
const BIG = 200000;
const SMALL_CTX = 50000;

const fire = (over = {}) => adviseSessionSwitch({
  model: OPUS, tokens: BIG, cacheTtl: '1h', sessionId: 's1', now: 1000, ...over,
});

/** The economics, asserted present so the type checker knows it is not null. */
function econ(input) {
  const e = switchEconomics(input);
  assert.ok(e, 'expected priced economics');
  return e;
}

/** The message, asserted present for the same reason. */
function said(over = {}) {
  const { message } = fire(over);
  assert.ok(message, 'expected a message');
  return message;
}

// --- the economics ---

test('payback is context-independent: both sides scale with the same tokens', () => {
  const sizes = [50000, 200000, 500000];
  const at5m = sizes.map((t) => econ({ model: OPUS, tokens: t, cacheTtl: '5m' }).paybackRequests);
  const at1h = sizes.map((t) => econ({ model: OPUS, tokens: t, cacheTtl: '1h' }).paybackRequests);
  assert.deepEqual(at5m, [9, 9, 9], 'a 5-minute cache repays in 9 requests at any size');
  assert.deepEqual(at1h, [14, 14, 14], 'a one-hour cache repays in 14 requests at any size');
});

test('the switch repays well inside a median turn', () => {
  const e = econ({ model: OPUS, tokens: BIG, cacheTtl: '1h' });
  assert.ok(
    e.paybackRequests < MEDIAN_TURN_REQUESTS,
    `payback ${e.paybackRequests} must beat the measured median turn of ${MEDIAN_TURN_REQUESTS}`,
  );
});

test('per-request cost uses the cache-read rate, which is where the money goes', () => {
  // 200k of context at Opus's $0.50/Mtok cache-read rate.
  const e = econ({ model: OPUS, tokens: 200000, cacheTtl: '1h' });
  assert.equal(Number(e.perRequestUsd.toFixed(3)), 0.1);
  assert.equal(Number(e.targetPerRequestUsd.toFixed(3)), 0.04);
  assert.equal(Number(e.savedPerRequest.toFixed(3)), 0.06);
});

test('an unknown TTL is priced as the expensive one, never the cheap one', () => {
  const unknown = econ({ model: OPUS, tokens: BIG, cacheTtl: null });
  const oneHour = econ({ model: OPUS, tokens: BIG, cacheTtl: '1h' });
  assert.equal(unknown.recacheUsd, oneHour.recacheUsd);
  assert.equal(unknown.oneHour, true);
});

test('no economics for a model already at or below the target rate', () => {
  assert.equal(switchEconomics({ model: 'claude-sonnet-5', tokens: BIG }), null, 'sonnet to sonnet saves nothing');
  assert.equal(switchEconomics({ model: 'claude-haiku-4-5-20251001', tokens: BIG }), null, 'haiku is already cheaper');
});

test('no economics without a priced model or real tokens', () => {
  assert.equal(switchEconomics({ model: 'not-a-model', tokens: BIG }), null);
  assert.equal(switchEconomics({ model: OPUS, tokens: 0 }), null);
  assert.equal(switchEconomics({ model: OPUS, tokens: NaN }), null);
  assert.equal(switchEconomics({ model: null, tokens: BIG }), null);
});

// --- when it speaks ---

test('an expensive model on a large context is worth saying out loud', () => {
  const message = said();
  assert.match(message, /^\[router\]/);
  assert.match(message, /\/model sonnet/);
  assert.match(message, /200k context/);
  assert.match(message, /repays in 14 requests/);
});

test('silent when a median turn saves less than the budget', () => {
  assert.equal(fire({ tokens: SMALL_CTX }).message, null);
});

test('the budget is a real dial, not decoration', () => {
  assert.ok(fire({ tokens: SMALL_CTX, settings: { budgetUsd: 0.2 } }).message, 'a lower budget speaks sooner');
  assert.equal(fire({ settings: { budgetUsd: 100 } }).message, null, 'a high one never speaks');
});

test('silent when switched off', () => {
  assert.equal(fire({ settings: { enabled: false } }).message, null);
});

test('silent on a model that is already cheap', () => {
  assert.equal(fire({ model: 'claude-sonnet-5' }).message, null);
  assert.equal(fire({ model: 'claude-haiku-4-5-20251001' }).message, null);
});

test('a session hears it once, then only after real growth', () => {
  const first = fire();
  assert.ok(first.message, 'the first time it speaks');

  const again = fire({ state: first.state });
  assert.equal(again.message, null, 'not on the very next prompt');
  assert.equal(again.state, first.state, 'and it keeps what it knew');

  const nudged = fire({ tokens: BIG * 1.2, state: first.state });
  assert.equal(nudged.message, null, 'not on a small increase either');

  const grown = fire({ tokens: BIG * REARM_GROWTH, state: first.state });
  assert.ok(grown.message, 'again once the numbers have really changed');
  assert.ok(grown.state, 'with fresh state');
  assert.equal(grown.state.tokens, BIG * REARM_GROWTH);
});

test('another session is another conversation', () => {
  const first = fire();
  const other = fire({ sessionId: 's2', state: first.state });
  assert.ok(other.message, 'state from a different session never silences this one');
});

// --- what it says ---

test('recent small work strengthens the message but is not required', () => {
  const plain = said();
  const small = said({ allSmall: true, smallCount: 6 });
  assert.match(small, /last 6 turns were all small work/);
  assert.doesNotMatch(plain, /small work/, 'it fires without small-work evidence — that was the old bug');
});

test('it hands the decision to the user and never takes it', () => {
  const message = said();
  assert.match(message, /theirs to change/);
  assert.match(message, /do not switch it for them/);
  assert.match(message, /opusplan/, 'the quality-preserving option is offered too');
});

test('it names a compaction first when the re-cache is worth avoiding', () => {
  assert.match(said(), /right after a \/compact/);
});

test('every figure in the message is a real number', () => {
  for (const tokens of [80000, 200000, 500000, 1000000]) {
    const message = said({ tokens });
    assert.doesNotMatch(message, /NaN|Infinity|undefined|\$\s/, `bad figure at ${tokens}: ${message}`);
  }
});
