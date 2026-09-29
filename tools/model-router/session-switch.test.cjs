'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  adviseSessionSwitch, predictModel, bestOpus, bestSonnet, switchEconomics, requestUsd,
  replaySwitchPolicy, formatReplay, MEDIAN_TURN_REQUESTS, POST_COMPACT_TOKENS,
} = require('./session-switch.cjs');

const OPUS5 = 'claude-opus-5';
const OPUS55 = 'claude-opus-5-5';
const SONNET55 = 'claude-sonnet-5-5';
const BIG = 200000;

// Completed turns as the transcript reader shapes them.
const small = () => ({ edits: 1, commands: 1, reads: 1, distinctFiles: 1 });
const trivial = () => ({ edits: 0, commands: 0, reads: 1, distinctFiles: 0 });
const complex = () => ({ edits: 12, commands: 20, reads: 15, distinctFiles: 6 });

const advise = (over = {}) => adviseSessionSwitch({
  model: OPUS55, tokens: BIG, cacheTtl: '1h', recent: [small()], prompt: 'what does this function return?',
  sessionId: 's1', now: 1000, ...over,
});

function econ(input) {
  const e = switchEconomics(input);
  assert.ok(e, 'expected priced economics');
  return e;
}

// --- which models ---

test('the best of each family is its newest and cheapest: Opus 5.5 and Sonnet 5.5', () => {
  assert.strictEqual(bestOpus(), OPUS55);
  assert.strictEqual(bestSonnet(), SONNET55);
});

// --- the economics ---

test('a request is priced on reads, writes and output', () => {
  // Opus 5.5: 200k x $0.20 + 2.9k x $8 + 2.5k x $20 = $0.113; Sonnet 5.5: $0.04 + $0.012 + $0.025 = $0.077.
  const e = econ({ model: OPUS55, tokens: BIG, cacheTtl: '1h' });
  assert.strictEqual(e.to, SONNET55, 'the target defaults to the best Sonnet');
  assert.strictEqual(e.perRequestUsd.toFixed(4), '0.1132');
  assert.strictEqual(e.targetPerRequestUsd.toFixed(4), '0.0766');
  const a = requestUsd(OPUS55, 100000, true);
  const b = requestUsd(OPUS55, 400000, true);
  assert.ok(a !== null && b !== null);
  assert.strictEqual(Number((b - a).toFixed(4)), 0.06, '300k more context costs 300k x $0.20/M more per request');
});

test('compacting first is what makes a switch repay fast', () => {
  const after = econ({ model: OPUS55, tokens: 460000, cacheTtl: '1h' });
  const before = econ({ model: OPUS55, tokens: 460000, cacheTtl: '1h', compactFirst: false });
  assert.ok(after.paybackRequests <= 6, `after /compact: ${after.paybackRequests}`);
  assert.ok(before.paybackRequests > MEDIAN_TURN_REQUESTS, `without: ${before.paybackRequests}`);
  assert.strictEqual(after.recacheUsd, (POST_COMPACT_TOKENS * 2 * 2) / 1e6, 're-cached at the Sonnet 1h rate on the compacted size');
});

test('an unknown TTL is priced as the expensive one', () => {
  assert.strictEqual(econ({ model: OPUS5, tokens: BIG, cacheTtl: null }).recacheUsd, econ({ model: OPUS5, tokens: BIG, cacheTtl: '1h' }).recacheUsd);
});

test('no economics without a priced model, real tokens, or a saving', () => {
  for (const bad of [{ model: 'nope', tokens: BIG }, { model: OPUS5, tokens: 0 }, { model: OPUS5, tokens: NaN }, { model: SONNET55, tokens: BIG }]) {
    assert.strictEqual(switchEconomics(bad), null, JSON.stringify(bad));
  }
});

// --- the prediction: from the message itself ---

test('Opus steps down to Sonnet 5.5 for a message that reads clearly small, with no history needed', () => {
  for (const prompt of ['what does this function return?', 'translate this into french', 'fix the typo in the readme', 'thanks']) {
    const down = predictModel({ model: OPUS55, recent: [], prompt });
    assert.deepStrictEqual([down.want, down.dir, down.fromPrompt], [SONNET55, 'down', true], prompt);
  }
  for (const prompt of ['build the export pipeline', 'why does this deadlock', 'yes do it', 'the other one too']) {
    assert.strictEqual(predictModel({ model: OPUS55, recent: [], prompt }).want, null, prompt);
  }
});

test('an older Opus is moved to Opus 5.5 when the work is not small', () => {
  for (const m of [OPUS5, 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-1']) {
    const p = predictModel({ model: m, recent: [complex()], prompt: 'build the export pipeline' });
    assert.deepStrictEqual([p.want, p.dir], [OPUS55, 'same'], m);
    assert.strictEqual(p.why, `${OPUS55} is newer and cheaper than ${m}`);
  }
  assert.strictEqual(predictModel({ model: OPUS5, prompt: 'what does this do?' }).want, SONNET55, 'small work goes further down');
});

test('Sonnet goes back to Opus 5.5 for anything not clearly small', () => {
  const up = predictModel({ model: SONNET55, recent: [small()], prompt: 'build the export pipeline' });
  assert.deepStrictEqual([up.want, up.dir, up.fromPrompt], [OPUS55, 'up', true], 'heavy: decided by the message');
  const unclear = predictModel({ model: SONNET55, recent: [small()], prompt: 'the other one too' });
  assert.deepStrictEqual([unclear.want, unclear.fromPrompt, unclear.why], [OPUS55, false, 'it may be bigger than it reads']);
  const after = predictModel({ model: SONNET55, recent: [complex()], prompt: 'rename x' });
  assert.deepStrictEqual([after.want, after.fromPrompt], [OPUS55, false], 'the last turn ran big');
  assert.strictEqual(predictModel({ model: SONNET55, recent: [small()], prompt: 'rename x' }).want, null, 'small work stays');
  assert.strictEqual(predictModel({ model: 'claude-sonnet-4-6', prompt: 'rename x' }).want, SONNET55, 'older, dearer Sonnet');
  assert.strictEqual(predictModel({ model: 'claude-sonnet-5', prompt: 'rename x' }).want, null, 'same price: a re-cache for nothing');
});

test('other families and unknown models get nothing', () => {
  for (const m of ['claude-haiku-4-5', 'claude-fable-5-1', null, 'gpt-5']) {
    assert.strictEqual(predictModel({ model: m, prompt: 'what is this?' }).want, null, String(m));
  }
  assert.strictEqual(predictModel({ model: 'claude-opus-6', prompt: 'build it' }).want, null, 'an Opus newer than the table is never moved back');
});

// --- the advice ---

test('small work on Opus is held before it runs, with the order that keeps the reasoning', () => {
  const { hold } = advise();
  assert.ok(hold);
  assert.match(hold, /^\[rcskills\] Before this runs: this is small work: it is a direct question — claude-sonnet-5-5 costs \$0\.08 vs \$0\.11 per message\./);
  assert.match(hold, /\/compact keep decisions and open tasks for "what does this function return\?", then \/model claude-sonnet-5-5, then send this again/);
  assert.match(hold, /To stay on claude-opus-5-5, just send it again\./);
});

test('Opus work on Sonnet is held before it runs', () => {
  const { hold } = advise({ model: SONNET55, prompt: 'build the export pipeline' });
  assert.ok(hold);
  assert.match(hold, /^\[rcskills\] Before this runs: this message needs Opus — it builds or changes something of several parts\. Run `\/model claude-opus-5-5`/);
});

test('every message gets its line, and a model is held at most once', () => {
  const first = advise();
  assert.ok(first.hold);
  const again = advise({ state: first.state });
  assert.strictEqual(again.hold, null);
  assert.match(String(again.message), /^\[next\] End your reply with exactly this line: "Next: \/compact .*then \/model claude-sonnet-5-5 — this is small work/);
  // Alternating small and big work must not hold every other message.
  const big = advise({ model: OPUS5, recent: [complex()], prompt: 'build the export pipeline', state: advise({ model: OPUS5 }).state });
  assert.strictEqual(big.hold, null);
  assert.match(String(big.message), /\/model claude-opus-5-5 — claude-opus-5-5 is newer and cheaper than claude-opus-5/);
  assert.ok(advise({ model: OPUS5, state: first.state }).hold, 'a new model starts again');
  assert.ok(advise({ state: first.state, sessionId: 's2' }).hold, 'another session is another conversation');
});

test('on the right model there is nothing to say', () => {
  for (const over of [{ prompt: 'build the export pipeline' }, { model: SONNET55, prompt: 'rename x' }]) {
    const r = advise(over);
    assert.strictEqual(r.hold, null);
    assert.strictEqual(r.message, null);
  }
});

test('a held message is handed back, because Claude Code erases it', () => {
  const prompt = 'what does this function return?\nand the one below it';
  const { hold } = advise({ prompt });
  assert.ok(hold && hold.endsWith(`Your message, to send again:\n${prompt}`), String(hold));
  const up = advise({ model: SONNET55, prompt: 'build the export pipeline' }).hold;
  assert.ok(up && up.endsWith('Your message, to send again:\nbuild the export pipeline'));
});

test('slash commands are never held: they are how the user acts on the advice', () => {
  for (const p of ['/compact keep decisions', '/model claude-sonnet-5-5', '/clear']) {
    const r = advise({ prompt: p });
    assert.strictEqual(r.hold, null, p);
    assert.strictEqual(r.message, null, p);
  }
});

test('advise mode relays a line instead of holding, in both directions', () => {
  const down = advise({ settings: { hold: false } });
  assert.strictEqual(down.hold, null);
  assert.match(down.message || '', /^\[next\] End your reply with exactly this line: "Next: \/compact keep .*, then \/model claude-sonnet-5-5 — /);
  const up = advise({ model: SONNET55, prompt: 'build the export pipeline', settings: { hold: false } });
  assert.strictEqual(up.hold, null);
  assert.match(up.message || '', /"Before your next message: \/model claude-opus-5-5 — it builds or changes something of several parts\."/);
});

test('the budget is the dial, and nothing is said when it is off', () => {
  assert.strictEqual(advise({ settings: { budgetUsd: 100 } }).hold, null, 'a saving below the budget says nothing');
  assert.ok(advise({ settings: { budgetUsd: 0.05 } }).hold);
  assert.strictEqual(advise({ settings: { enabled: false } }).hold, null);
  assert.strictEqual(advise({ model: SONNET55, prompt: 'build it', settings: { enabled: false } }).hold, null);
});

test('every figure in the advice is a real number', () => {
  for (const tokens of [80000, 200000, 1000000]) {
    for (const model of [OPUS5, OPUS55]) {
      const r = advise({ tokens, model });
      const text = r.hold || r.message;
      assert.ok(text, `${model} at ${tokens}`);
      assert.doesNotMatch(text, /NaN|Infinity|undefined|\$0\.00 vs/);
    }
  }
});

// --- the replay the backtest reports ---

test('the replay counts complex work that would have run on Sonnet', () => {
  const session = [
    { prompt: 'what is this?', ...trivial() }, // down to Sonnet here, decided from the prompt
    { prompt: 'and this?', ...trivial() },
    { prompt: 'rename x', ...small() },
    { prompt: 'and that one?', ...trivial() },
    { prompt: 'and the next one?', ...complex() }, // read small, ran big: the degradation the replay must count
    { prompt: 'rename y', ...trivial() }, // back up to Opus, known only after the complex turn
  ];
  const r = replaySwitchPolicy([session]);
  assert.strictEqual(r.turns, 6);
  assert.strictEqual(r.down, 1);
  assert.strictEqual(r.onSonnet, 5);
  assert.strictEqual(r.complexOnSonnet, 1);
  assert.strictEqual(r.up, 1);
  assert.strictEqual(r.held, 1, 'only the step down was decided before its turn ran');
  assert.match(formatReplay(r), /complex work on Sonnet: 1 \(20% of Sonnet turns\)/);
});
