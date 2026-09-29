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

// --- the prediction: Sonnet by default, Opus for thinking ---

test('Opus steps down to Sonnet 5.5 for any new message that is not thinking work', () => {
  const cases = {
    'what does this function return?': /^this is small work: it is a direct question$/,
    'fix the typo in the readme': /^this is small work: it is a small edit$/,
    'build the export pipeline': /^this is building, not reasoning: it builds or changes something of several parts$/,
    '1. add a settings page\n2. persist it': /^this is building, not reasoning: it asks for several things$/,
  };
  for (const [prompt, why] of Object.entries(cases)) {
    const p = predictModel({ model: OPUS55, prompt });
    assert.deepStrictEqual([p.want, p.dir, p.fromPrompt], [SONNET55, 'down', true], prompt);
    assert.match(p.why, why);
  }
});

test('Opus stays for thinking work, and never switches in the middle of a task', () => {
  for (const prompt of ['why does this deadlock', 'compare postgres and mongodb for us', 'the tests are failing, fix them', 'yes do it', 'continue', 'the other one too']) {
    assert.strictEqual(predictModel({ model: OPUS55, prompt }).want, null, prompt);
  }
});

test('Sonnet goes up to Opus 5.5 before thinking work, and only then', () => {
  for (const prompt of ['why does this deadlock', 'do a security review of the auth flow', 'the tests are failing, fix them']) {
    const p = predictModel({ model: SONNET55, prompt });
    assert.deepStrictEqual([p.want, p.dir, p.fromPrompt], [OPUS55, 'up', true], prompt);
  }
  for (const prompt of ['build the export pipeline', 'rename x', 'continue', 'yes do it']) {
    assert.strictEqual(predictModel({ model: SONNET55, recent: [complex()], prompt }).want, null, prompt);
  }
});

test('an older model moves to the newest of its family', () => {
  for (const m of [OPUS5, 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-1']) {
    const p = predictModel({ model: m, prompt: 'why does this deadlock' });
    assert.deepStrictEqual([p.want, p.dir, p.why], [OPUS55, 'same', `${OPUS55} is newer and cheaper than ${m}`], m);
  }
  assert.strictEqual(predictModel({ model: OPUS5, prompt: 'build the export pipeline' }).want, SONNET55, 'building goes to Sonnet from any Opus');
  assert.strictEqual(predictModel({ model: 'claude-sonnet-4-6', prompt: 'rename x' }).want, SONNET55, 'older, dearer Sonnet');
  assert.strictEqual(predictModel({ model: 'claude-sonnet-5', prompt: 'rename x' }).want, null, 'same price: a re-cache for nothing');
});

test('other families and unknown models get nothing', () => {
  for (const m of ['claude-haiku-4-5', 'claude-fable-5-1', null, 'gpt-5']) {
    assert.strictEqual(predictModel({ model: m, prompt: 'why is this slow?' }).want, null, String(m));
  }
  assert.strictEqual(predictModel({ model: 'claude-opus-6', prompt: 'why does it hang' }).want, null, 'an Opus newer than the table is never moved back');
});

// --- the advice ---

test('work on Opus is held before it runs, with the order that keeps the reasoning', () => {
  const { hold } = advise();
  assert.ok(hold);
  assert.match(hold, /^\[rcskills\] Before this runs: this is small work: it is a direct question — claude-sonnet-5-5 costs \$0\.08 vs \$0\.11 per message\./);
  assert.match(hold, /\/compact keep decisions and open tasks for "what does this function return\?", then \/model claude-sonnet-5-5, then send this again/);
  assert.match(hold, /To stay on claude-opus-5-5, just send it again\./);
});

test('thinking work on Sonnet is held before it runs', () => {
  const { hold } = advise({ model: SONNET55, prompt: 'why does this deadlock' });
  assert.ok(hold);
  assert.match(hold, /^\[rcskills\] Before this runs: this message needs Opus — it asks for reasoning, analysis or judgement\. Run `\/model claude-opus-5-5`/);
});

test('every message gets its line, and a model is held at most once', () => {
  const first = advise();
  assert.ok(first.hold);
  const again = advise({ state: first.state });
  assert.strictEqual(again.hold, null);
  assert.match(String(again.message), /^\[next\] End your reply with exactly this line: "Next: \/compact .*then \/model claude-sonnet-5-5 — this is small work/);
  // Alternating kinds of work must not hold every other message.
  const think = advise({ model: OPUS5, prompt: 'why does this deadlock', state: advise({ model: OPUS5 }).state });
  assert.strictEqual(think.hold, null);
  assert.match(String(think.message), /\/model claude-opus-5-5 — claude-opus-5-5 is newer and cheaper than claude-opus-5/);
  assert.ok(advise({ model: OPUS5, state: first.state }).hold, 'a new model starts again');
  assert.ok(advise({ state: first.state, sessionId: 's2' }).hold, 'another session is another conversation');
});

test('on the right model there is nothing to say', () => {
  for (const over of [{ prompt: 'why does this deadlock' }, { prompt: 'continue' }, { model: SONNET55, prompt: 'build the export pipeline' }]) {
    const r = advise(over);
    assert.strictEqual(r.hold, null, over.prompt);
    assert.strictEqual(r.message, null, over.prompt);
  }
});

test('a held message is handed back, because Claude Code erases it', () => {
  const prompt = 'what does this function return?\nand the one below it';
  const { hold } = advise({ prompt });
  assert.ok(hold && hold.endsWith(`Your message, to send again:\n${prompt}`), String(hold));
  const up = advise({ model: SONNET55, prompt: 'why does this deadlock' }).hold;
  assert.ok(up && up.endsWith('Your message, to send again:\nwhy does this deadlock'));
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
  const up = advise({ model: SONNET55, prompt: 'why does this deadlock', settings: { hold: false } });
  assert.strictEqual(up.hold, null);
  assert.match(up.message || '', /"Before your next message: \/model claude-opus-5-5 — it asks for reasoning, analysis or judgement\."/);
});

test('the budget is the dial, and nothing is said when it is off', () => {
  assert.strictEqual(advise({ settings: { budgetUsd: 100 } }).hold, null, 'a saving below the budget says nothing');
  assert.ok(advise({ settings: { budgetUsd: 0.05 } }).hold);
  assert.strictEqual(advise({ settings: { enabled: false } }).hold, null);
  assert.strictEqual(advise({ model: SONNET55, prompt: 'why is it slow', settings: { enabled: false } }).hold, null);
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

test('the replay counts thinking work that would have run on Sonnet, and every switch', () => {
  const session = [
    { prompt: 'what is this?', ...trivial() }, // down to Sonnet, decided from the prompt
    { prompt: 'build the export pipeline', ...complex() }, // a complex build: Sonnet's job now
    { prompt: 'why does it deadlock', ...complex() }, // thinking: up to Opus before it runs
    { prompt: 'yes do it', ...complex() }, // a go-ahead: no switch mid-task
    { prompt: 'rename x', ...small() }, // new small work: down again
  ];
  const r = replaySwitchPolicy([session]);
  assert.deepStrictEqual(
    [r.turns, r.onSonnet, r.complexOnSonnet, r.thinking, r.thinkingOnSonnet, r.down, r.up, r.held],
    [5, 3, 1, 1, 0, 2, 1, 3],
  );
  assert.match(formatReplay(r), /thinking on Sonnet: +0 of 1 reasoning or diagnosis messages/);
  assert.match(formatReplay(r), /switches: +2 down, 1 up/);
});
