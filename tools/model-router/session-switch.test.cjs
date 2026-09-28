'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  adviseSessionSwitch, predictModel, bestOpus, switchEconomics, requestUsd,
  MEDIAN_TURN_REQUESTS, POST_COMPACT_TOKENS,
} = require('./session-switch.cjs');

const OPUS5 = 'claude-opus-5';
const OPUS55 = 'claude-opus-5-5';
const BIG = 200000;

const advise = (over = {}) => adviseSessionSwitch({
  model: OPUS5, tokens: BIG, cacheTtl: '1h', prompt: 'what does this function return?',
  sessionId: 's1', now: 1000, ...over,
});

function econ(input) {
  const e = switchEconomics(input);
  assert.ok(e, 'expected priced economics');
  return e;
}

// --- which Opus ---

test('the best Opus is the newest and the cheapest: Opus 5.5', () => {
  assert.strictEqual(bestOpus(), OPUS55);
});

test('every older Opus is told to move to Opus 5.5, and nothing else is', () => {
  for (const m of [OPUS5, 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5', 'claude-opus-4-1', 'claude-opus-4']) {
    const p = predictModel({ model: m });
    assert.strictEqual(p.want, OPUS55, m);
    assert.strictEqual(p.why, `${OPUS55} is newer and cheaper than ${m}`);
  }
  assert.strictEqual(predictModel({ model: 'claude-opus-4-8-20260101' }).want, OPUS55, 'dated ids normalise');
  for (const m of [OPUS55, 'claude-sonnet-5', 'claude-haiku-4-5', 'claude-fable-5-1', null, 'gpt-5']) {
    assert.strictEqual(predictModel({ model: m }).want, null, String(m));
  }
});

test('an Opus newer than the price table is left alone', () => {
  assert.strictEqual(predictModel({ model: 'claude-opus-6' }).want, null);
});

// --- the economics ---

test('a request is priced on reads, writes and output', () => {
  // Opus 5: 200k x $0.50 + 2.9k x $10 + 2.5k x $25 = $0.19; Opus 5.5: $0.04 + $0.023 + $0.05 = $0.11.
  const e = econ({ model: OPUS5, tokens: BIG, cacheTtl: '1h', target: OPUS55 });
  assert.strictEqual(e.perRequestUsd.toFixed(4), '0.1915');
  assert.strictEqual(e.targetPerRequestUsd.toFixed(4), '0.1132');
  const a = requestUsd(OPUS55, 100000, true);
  const b = requestUsd(OPUS55, 400000, true);
  assert.ok(a !== null && b !== null);
  assert.strictEqual(Number((b - a).toFixed(4)), 0.06, '300k more context costs 300k x $0.20/M more per request');
});

test('compacting first is what makes the switch repay fast', () => {
  const after = econ({ model: OPUS5, tokens: 800000, cacheTtl: '1h' });
  const before = econ({ model: OPUS5, tokens: 800000, cacheTtl: '1h', compactFirst: false });
  assert.strictEqual(after.to, OPUS55, 'the target defaults to the best Opus');
  assert.ok(after.paybackRequests <= 5, `after /compact: ${after.paybackRequests}`);
  assert.ok(before.paybackRequests > after.paybackRequests * 3, `without: ${before.paybackRequests}`);
  assert.strictEqual(after.recacheUsd, (POST_COMPACT_TOKENS * 4 * 2) / 1e6, 're-cached at the Opus 5.5 1h rate on the compacted size');
});

test('an unknown TTL is priced as the expensive one', () => {
  assert.strictEqual(econ({ model: OPUS5, tokens: BIG, cacheTtl: null }).recacheUsd, econ({ model: OPUS5, tokens: BIG, cacheTtl: '1h' }).recacheUsd);
});

test('no economics without a priced model, real tokens, or a saving', () => {
  for (const bad of [{ model: 'nope', tokens: BIG }, { model: OPUS5, tokens: 0 }, { model: OPUS5, tokens: NaN }, { model: OPUS55, tokens: BIG }]) {
    assert.strictEqual(switchEconomics(bad), null, JSON.stringify(bad));
  }
});

// --- the advice ---

test('the first message on an older Opus is held before it runs, with the order that keeps the reasoning', () => {
  const { hold } = advise();
  assert.ok(hold);
  assert.match(hold, /^\[rcskills\] Before this runs: claude-opus-5-5 is newer and cheaper than claude-opus-5 — \$0\.11 vs \$0\.19 per message\./);
  assert.match(hold, /\/compact keep decisions and open tasks for "what does this function return\?", then \/model claude-opus-5-5, then send this again/);
  assert.match(hold, /To stay on claude-opus-5, just send it again\./);
  assert.doesNotMatch(hold, /sonnet/i, 'Sonnet is never suggested');
});

test('any message is enough: the move is never a downgrade, so nothing is guessed from the prompt', () => {
  for (const prompt of ['rename x', 'architect the whole billing system and migrate every service']) {
    assert.ok(advise({ prompt }).hold, prompt);
  }
});

test('sending a held message again runs it, and every later message still says so', () => {
  const first = advise();
  assert.ok(first.hold);
  const again = advise({ state: first.state });
  assert.strictEqual(again.hold, null);
  assert.match(String(again.message), /^\[next\] End your reply with exactly this line: "Next: \/compact .*then \/model claude-opus-5-5 — newer and cheaper than claude-opus-5; \$0\.11 vs \$0\.19 per message\."$/);
  assert.strictEqual(advise({ state: again.state }).hold, null, 'never held twice');
  assert.ok(advise({ model: 'claude-opus-4-8', state: first.state }).hold, 'a new model starts again');
  assert.ok(advise({ state: first.state, sessionId: 's2' }).hold, 'another session is another conversation');
});

test('once on Opus 5.5 there is nothing to say', () => {
  const r = advise({ model: OPUS55 });
  assert.strictEqual(r.hold, null);
  assert.strictEqual(r.message, null);
});

test('a held message is handed back, because Claude Code erases it', () => {
  const prompt = 'what does this function return?\nand the one below it';
  const { hold } = advise({ prompt });
  assert.ok(hold && hold.endsWith(`Your message, to send again:\n${prompt}`), String(hold));
});

test('slash commands are never held: they are how the user acts on the advice', () => {
  for (const p of ['/compact keep decisions', '/model claude-opus-5-5', '/clear']) {
    const r = advise({ prompt: p });
    assert.strictEqual(r.hold, null, p);
    assert.strictEqual(r.message, null, p);
  }
});

test('advise mode relays the line instead of holding', () => {
  const r = advise({ settings: { hold: false } });
  assert.strictEqual(r.hold, null);
  assert.match(r.message || '', /^\[next\] End your reply with exactly this line: "Next: \/compact keep .*, then \/model claude-opus-5-5 — /);
});

test('the budget is the dial, and nothing is said when it is off', () => {
  assert.strictEqual(advise({ settings: { budgetUsd: 100 } }).hold, null, 'a saving below the budget says nothing');
  assert.ok(advise({ settings: { budgetUsd: 0.05 } }).hold);
  assert.strictEqual(advise({ settings: { enabled: false } }).hold, null);
});

test('a fresh session saves too little to interrupt; a working one does not', () => {
  // 1k of context: $0.019 a request, $0.41 a median turn — under the $0.50 default.
  assert.strictEqual(advise({ tokens: 1000 }).hold, null);
  assert.ok(advise({ tokens: 80000 }).hold);
  assert.ok(econ({ model: OPUS5, tokens: 80000 }).paybackRequests <= MEDIAN_TURN_REQUESTS);
});

test('every figure in the advice is a real number', () => {
  for (const tokens of [80000, 200000, 1000000]) {
    for (const model of [OPUS5, 'claude-opus-4-1']) {
      const r = advise({ tokens, model });
      const text = r.hold || r.message;
      assert.ok(text, `${model} at ${tokens}`);
      assert.doesNotMatch(text, /NaN|Infinity|undefined|\$0\.00 vs/);
    }
  }
});
