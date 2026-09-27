'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  adviseSessionSwitch, predictModel, readPrompt, switchEconomics, requestUsd, replaySwitchPolicy, formatReplay,
  MEDIAN_TURN_REQUESTS, SMALL_RUN, POST_COMPACT_TOKENS,
} = require('./session-switch.cjs');

const OPUS = 'claude-opus-5';
const OPUS55 = 'claude-opus-5-5';
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

/** The hold or line, whichever the advice produced, asserted present. */
function said(over = {}) {
  const r = advise(over);
  const text = r.hold || r.message;
  assert.ok(text, 'expected advice');
  return text;
}

// --- the economics ---

test('a request is priced on reads, writes and output, not reads alone', () => {
  // Opus 5.5 reads its cache at Sonnet's $0.20/M: a reads-only model saw no saving at all.
  const e = econ({ model: OPUS55, tokens: BIG, cacheTtl: '1h' });
  assert.ok(e.savedPerRequest > 0.03 && e.savedPerRequest < 0.04, `saved ${e.savedPerRequest}`);
  const a = requestUsd(OPUS55, 100000, true);
  const b = requestUsd(OPUS55, 400000, true);
  assert.ok(a !== null && b !== null);
  assert.strictEqual(Number((b - a).toFixed(4)), 0.06, '300k more context costs 300k x $0.20/M more per request');
});

test('compacting first is what makes a switch pay on Opus 5.5', () => {
  const after = econ({ model: OPUS55, tokens: 460000, cacheTtl: '1h' });
  const before = econ({ model: OPUS55, tokens: 460000, cacheTtl: '1h', compactFirst: false });
  assert.ok(after.paybackRequests <= 6, `after /compact: ${after.paybackRequests}`);
  assert.ok(before.paybackRequests > MEDIAN_TURN_REQUESTS, `without: ${before.paybackRequests}`);
  assert.strictEqual(after.recacheUsd, (POST_COMPACT_TOKENS * 2 * 2) / 1e6, 're-cached at Sonnet 1h rate on the compacted size');
});

test('an unknown TTL is priced as the expensive one', () => {
  assert.strictEqual(econ({ model: OPUS, tokens: BIG, cacheTtl: null }).recacheUsd, econ({ model: OPUS, tokens: BIG, cacheTtl: '1h' }).recacheUsd);
});

test('no economics without a priced model, real tokens, or a saving', () => {
  for (const bad of [{ model: 'nope', tokens: BIG }, { model: OPUS, tokens: 0 }, { model: OPUS, tokens: NaN }, { model: SONNET, tokens: BIG }]) {
    assert.strictEqual(switchEconomics(bad), null, JSON.stringify(bad));
  }
});

// --- reading the prompt ---

test('a short new work order is recognised even though it reads small', () => {
  // These are real prompts that ran as complex work after the tier rule sent them to Sonnet.
  for (const p of ['add a setting where the skill prompts the user to compact',
    'measure how often claude actually delegates', 'architect the product accordingly', 'start planning the build']) {
    assert.strictEqual(readPrompt(p).workOrder, true, p);
  }
});

test('a trivial edit is not a work order just because it says add', () => {
  assert.strictEqual(readPrompt('add a comment above this line').workOrder, false);
  assert.strictEqual(readPrompt('fix the typo in the readme').workOrder, false);
});

// --- predicting the model ---

test('only Opus sessions are ever stepped down, and only after measured small work', () => {
  assert.strictEqual(predictModel({ model: OPUS55, recent: smallRun(), prompt: 'and what about this one?' }).want, 'sonnet');
  assert.strictEqual(predictModel({ model: 'claude-opus-4-1', recent: smallRun(), prompt: 'ok, next one?' }).want, 'sonnet', 'every Opus version');
  assert.strictEqual(predictModel({ model: OPUS, recent: smallRun(SMALL_RUN - 1), prompt: 'next?' }).want, null, 'not before the run is long enough');
  assert.strictEqual(predictModel({ model: OPUS, recent: [...smallRun(2), complex()], prompt: 'next?' }).want, null, 'one big turn breaks the run');
  assert.strictEqual(predictModel({ model: 'claude-haiku-4-5-20251001', recent: smallRun(), prompt: 'next?' }).want, null);
  assert.strictEqual(predictModel({ model: 'claude-fable-5', recent: smallRun(), prompt: 'next?' }).want, null, 'Opus only');
});

test('an Opus session doing small work stays on Opus for a prompt that needs it', () => {
  for (const p of ['implement retry logic across the whole worker pool', 'debug this intermittent race condition', 'add a caching layer']) {
    assert.strictEqual(predictModel({ model: OPUS, recent: smallRun(), prompt: p }).want, null, p);
  }
});

test('a Sonnet session is sent back to Opus before the work, not after', () => {
  const before = predictModel({ model: SONNET, recent: smallRun(), prompt: 'refactor the router into modules' });
  assert.strictEqual(before.want, 'opus');
  assert.strictEqual(before.fromPrompt, true, 'the prompt itself said so');
  const after = predictModel({ model: SONNET, recent: [complex()], prompt: 'ok' });
  assert.strictEqual(after.want, 'opus');
  assert.strictEqual(after.fromPrompt, false, 'known only after the turn ran');
  assert.strictEqual(predictModel({ model: SONNET, recent: smallRun(), prompt: 'thanks, what next?' }).want, null);
});

// --- the advice, before the prompt runs ---

test('small work on Opus is held before it runs, with the order that keeps the reasoning', () => {
  const { hold, message } = advise({ model: OPUS55 });
  assert.strictEqual(message, null);
  assert.ok(hold);
  assert.match(hold, /^\[rcskills\] Before this runs: the last 3 turns were small and this one reads small\./);
  assert.match(hold, /\/compact keep decisions and open tasks for "what does this function return\?", then \/model sonnet, then send this again/);
  assert.match(hold, /To run it on claude-opus-5-5, just send it again\./);
});

test('Opus work on Sonnet is held before it runs', () => {
  const r = advise({ model: SONNET, prompt: 'build the export pipeline for the reports' });
  assert.ok(r.hold);
  assert.match(r.hold, /^\[rcskills\] Before this runs: this session is on Sonnet and this message needs Opus — it starts new work\./);
  assert.match(r.hold, /\/model opus/);
});

test('sending a held message again runs it, and the advice is not repeated on that model', () => {
  const first = advise({ model: OPUS55 });
  assert.ok(first.hold);
  const again = advise({ model: OPUS55, state: first.state });
  assert.strictEqual(again.hold, null);
  assert.strictEqual(again.message, null);
  assert.ok(advise({ model: OPUS, state: first.state }).hold, 'a new model starts again');
  assert.ok(advise({ model: OPUS55, state: first.state, sessionId: 's2' }).hold, 'another session is another conversation');
});

test('a held message is handed back, because Claude Code erases it', () => {
  const prompt = 'what does this function return?\nand the one below it';
  const { hold } = advise({ model: OPUS55, prompt });
  assert.ok(hold);
  assert.ok(hold.endsWith(`Your message, to send again:\n${prompt}`), hold);
  const up = advise({ model: SONNET, prompt: 'build the export pipeline' }).hold;
  assert.ok(up && up.endsWith('Your message, to send again:\nbuild the export pipeline'));
});

test('slash commands are never held: they are how the user acts on the advice', () => {
  for (const p of ['/compact keep decisions', '/model sonnet', '/clear']) {
    const r = advise({ model: OPUS55, prompt: p });
    assert.strictEqual(r.hold, null, p);
    assert.strictEqual(r.message, null, p);
  }
});

test('advise mode relays a line instead of holding, in both directions', () => {
  const down = advise({ model: OPUS55, settings: { hold: false } });
  assert.strictEqual(down.hold, null);
  assert.match(down.message || '', /^\[next\] End your reply with exactly this line: "Next: \/compact keep .*, then \/model sonnet — /);
  const up = advise({ model: SONNET, prompt: 'build the export pipeline', settings: { hold: false } });
  assert.strictEqual(up.hold, null);
  assert.match(up.message || '', /"Before your next message: \/model opus — it starts new work\."/);
});

test('the budget is the dial, and nothing is said when it is off', () => {
  assert.strictEqual(advise({ settings: { budgetUsd: 100 } }).hold, null, 'a saving below the budget says nothing');
  assert.ok(advise({ settings: { budgetUsd: 0.05 } }).hold);
  assert.strictEqual(advise({ settings: { enabled: false } }).hold, null);
  assert.strictEqual(advise({ model: SONNET, prompt: 'build it', settings: { enabled: false } }).hold, null);
});

test('every figure in the advice is a real number', () => {
  for (const tokens of [80000, 200000, 1000000]) {
    for (const model of [OPUS, OPUS55]) assert.doesNotMatch(said({ tokens, model }), /NaN|Infinity|undefined|\$0\.00 vs/);
  }
});

// --- the replay the backtest reports ---

test('the replay counts complex work that would have run on Sonnet', () => {
  const session = [
    { prompt: 'what is this?', ...trivial() },
    { prompt: 'and this?', ...trivial() },
    { prompt: 'rename x', ...small() },
    { prompt: 'and that one?', ...trivial() }, // down to Sonnet here, decided from the prompt
    { prompt: 'ok', ...complex() }, // read small, ran big: the degradation the replay must count
    { prompt: 'fine', ...trivial() }, // back up to Opus, known only after the complex turn
  ];
  const r = replaySwitchPolicy([session]);
  assert.strictEqual(r.turns, 6);
  assert.strictEqual(r.down, 1);
  assert.strictEqual(r.onSonnet, 2);
  assert.strictEqual(r.complexOnSonnet, 1);
  assert.strictEqual(r.up, 1);
  assert.strictEqual(r.held, 1, 'only the step down was decided before its turn ran');
  assert.match(formatReplay(r), /complex work on Sonnet: 1 \(50% of Sonnet turns\)/);
});
