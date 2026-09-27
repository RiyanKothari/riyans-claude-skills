'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  adviseSessionSwitch, predictModel, readPrompt, switchEconomics, replaySwitchPolicy, formatReplay,
  MEDIAN_TURN_REQUESTS, SMALL_RUN,
} = require('./session-switch.cjs');

const OPUS = 'claude-opus-5';
const SONNET = 'claude-sonnet-5';
const BIG = 200000;

// Completed turns as the transcript reader shapes them.
const small = () => ({ edits: 1, commands: 1, reads: 1, distinctFiles: 1 });
const trivial = () => ({ edits: 0, commands: 0, reads: 1, distinctFiles: 0 });
const complex = () => ({ edits: 12, commands: 20, reads: 15, distinctFiles: 6 });
const smallRun = (n = SMALL_RUN) => Array.from({ length: n }, small);

const advise = (over = {}) => adviseSessionSwitch({
  model: OPUS, tokens: BIG, cacheTtl: '1h', recent: smallRun(), prompt: 'what does this function return?',
  sessionId: 's1', now: 1000, ...over,
});

function econ(input) {
  const e = switchEconomics(input);
  assert.ok(e, 'expected priced economics');
  return e;
}

// --- the economics ---

test('payback is context-independent: both sides scale with the same tokens', () => {
  const at = (ttl) => [50000, 200000, 500000].map((t) => econ({ model: OPUS, tokens: t, cacheTtl: ttl }).paybackRequests);
  assert.deepEqual(at('5m'), [9, 9, 9]);
  assert.deepEqual(at('1h'), [14, 14, 14]);
  assert.ok(14 < MEDIAN_TURN_REQUESTS, 'a switch repays inside a median turn');
});

test('an unknown TTL is priced as the expensive one', () => {
  assert.equal(econ({ model: OPUS, tokens: BIG, cacheTtl: null }).recacheUsd, econ({ model: OPUS, tokens: BIG, cacheTtl: '1h' }).recacheUsd);
});

test('no economics without a priced model, real tokens, or a saving', () => {
  for (const bad of [{ model: 'nope', tokens: BIG }, { model: OPUS, tokens: 0 }, { model: OPUS, tokens: NaN }, { model: SONNET, tokens: BIG }]) {
    assert.equal(switchEconomics(bad), null, JSON.stringify(bad));
  }
});

// --- reading the prompt ---

test('a short new work order is recognised even though it reads small', () => {
  // These are real prompts that ran as complex work after the tier rule sent them to Sonnet.
  for (const p of ['add a setting where the skill prompts the user to compact',
    'measure how often claude actually delegates', 'architect the product accordingly', 'start planning the build']) {
    assert.equal(readPrompt(p).workOrder, true, p);
  }
});

test('a trivial edit is not a work order just because it says add', () => {
  assert.equal(readPrompt('add a comment above this line').workOrder, false);
  assert.equal(readPrompt('fix the typo in the readme').workOrder, false);
});

// --- predicting the model ---

test('only Opus sessions are ever stepped down, and only after measured small work', () => {
  assert.equal(predictModel({ model: OPUS, recent: smallRun(), prompt: 'and what about this one?' }).want, 'sonnet');
  assert.equal(predictModel({ model: 'claude-opus-4-1', recent: smallRun(), prompt: 'ok, next one?' }).want, 'sonnet', 'every Opus version');
  assert.equal(predictModel({ model: OPUS, recent: smallRun(SMALL_RUN - 1), prompt: 'next?' }).want, null, 'not before the run is long enough');
  assert.equal(predictModel({ model: OPUS, recent: [...smallRun(2), complex()], prompt: 'next?' }).want, null, 'one big turn breaks the run');
  assert.equal(predictModel({ model: 'claude-haiku-4-5-20251001', recent: smallRun(), prompt: 'next?' }).want, null);
  assert.equal(predictModel({ model: 'claude-fable-5', recent: smallRun(), prompt: 'next?' }).want, null, 'Opus only');
});

test('an Opus session doing small work stays on Opus for a prompt that needs it', () => {
  for (const p of ['implement retry logic across the whole worker pool', 'debug this intermittent race condition', 'add a caching layer']) {
    assert.equal(predictModel({ model: OPUS, recent: smallRun(), prompt: p }).want, null, p);
  }
});

test('a Sonnet session is sent back to Opus before the work, not after', () => {
  const before = predictModel({ model: SONNET, recent: smallRun(), prompt: 'refactor the router into modules' });
  assert.equal(before.want, 'opus');
  assert.equal(before.fromPrompt, true, 'the prompt itself said so');
  const after = predictModel({ model: SONNET, recent: [complex()], prompt: 'ok' });
  assert.equal(after.want, 'opus');
  assert.equal(after.fromPrompt, false, 'known only after the turn ran');
  assert.equal(predictModel({ model: SONNET, recent: smallRun(), prompt: 'thanks, what next?' }).want, null);
});

// --- the advice ---

test('stepping down is a line to relay, with the order that keeps the reasoning', () => {
  const { message, hold } = advise();
  assert.equal(hold, null);
  assert.ok(message);
  assert.match(message, /^\[router\] Model: the next messages can run on Sonnet/);
  assert.match(message, /\/compact keep the decisions, open tasks and reasoning/);
  assert.match(message, /while still on Opus/);
  assert.match(message, /then `\/model sonnet`/);
  assert.match(message, /do not switch it for them/);
});

test('it is not worth a line when the saving is small', () => {
  assert.equal(advise({ tokens: 30000 }).message, null);
  assert.ok(advise({ tokens: 30000, settings: { budgetUsd: 0.05 } }).message, 'the budget is the dial');
});

test('a message that needs Opus is held once on Sonnet, then goes through if sent again', () => {
  const prompt = 'build the export pipeline for the reports';
  const first = advise({ model: SONNET, prompt });
  assert.ok(first.hold);
  assert.match(first.hold, /needs Opus/);
  assert.match(first.hold, /\/model opus/);
  assert.match(first.hold, /send it again/);
  const again = advise({ model: SONNET, prompt, state: first.state });
  assert.equal(again.hold, null, 'sending it again runs it');
});

test('advise mode says it instead of holding', () => {
  const r = advise({ model: SONNET, prompt: 'build the export pipeline', settings: { hold: false } });
  assert.equal(r.hold, null);
  assert.ok(r.message);
  assert.match(r.message, /needs Opus/);
});

test('each recommendation is made once per model, and re-arms when the model changes', () => {
  const first = advise();
  assert.ok(first.message);
  assert.equal(advise({ state: first.state }).message, null, 'not repeated while deciding');
  assert.ok(advise({ state: first.state, model: 'claude-opus-5-5' }).message, 'a new model starts again');
  assert.ok(advise({ state: first.state, sessionId: 's2' }).message, 'another session is another conversation');
});

test('silent when switched off', () => {
  assert.equal(advise({ settings: { enabled: false } }).message, null);
  assert.equal(advise({ model: SONNET, prompt: 'build it', settings: { enabled: false } }).hold, null);
});

test('every figure in the advice is a real number', () => {
  for (const tokens of [80000, 200000, 1000000]) {
    const { message } = advise({ tokens });
    assert.ok(message);
    assert.doesNotMatch(message, /NaN|Infinity|undefined/);
  }
});

// --- the replay the backtest reports ---

test('the replay counts complex work that would have run on Sonnet', () => {
  const session = [
    { prompt: 'what is this?', ...trivial() },
    { prompt: 'and this?', ...trivial() },
    { prompt: 'rename x', ...small() },
    { prompt: 'and that one?', ...trivial() }, // down to Sonnet here
    { prompt: 'ok', ...complex() }, // read small, ran big: the degradation the replay must count
    { prompt: 'fine', ...trivial() }, // back up to Opus after the complex turn
  ];
  const r = replaySwitchPolicy([session]);
  assert.equal(r.turns, 6);
  assert.equal(r.down, 1);
  assert.equal(r.onSonnet, 2);
  assert.equal(r.complexOnSonnet, 1);
  assert.equal(r.up, 1);
  assert.match(formatReplay(r), /complex work on Sonnet: 1 \(50% of Sonnet turns\)/);
});
