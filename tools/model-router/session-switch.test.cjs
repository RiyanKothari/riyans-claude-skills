'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  adviseSessionSwitch, predictModel, bestModel, choiceReport, bestOf, switchEconomics, requestUsd,
  MEDIAN_TURN_REQUESTS, POST_COMPACT_TOKENS,
} = require('./session-switch.cjs');
const cost = require('./cost.cjs');

const OPUS5 = 'claude-opus-5';
const OPUS55 = 'claude-opus-5-5';
const SONNET55 = 'claude-sonnet-5-5';
const BIG = 200000;

const advise = (over = {}) => adviseSessionSwitch({
  model: SONNET55, tokens: BIG, cacheTtl: '1h', prompt: 'build the export pipeline',
  sessionId: 's1', now: 1000, ...over,
});

function econ(input) {
  const e = switchEconomics(input);
  assert.ok(e, 'expected priced economics');
  return e;
}

// --- which model ---

test('the best model is chosen per task, not per token: Opus 5.5', () => {
  // Sonnet 5.5 is cheaper per token but takes more of them: $14.20 a task vs $13.00.
  const s = requestUsd(SONNET55, BIG, true);
  const o = requestUsd(OPUS55, BIG, true);
  assert.ok(s !== null && o !== null && s < o, 'Sonnet is cheaper per message');
  assert.ok(cost.TASK_BENCH[SONNET55].usdPerTask > cost.TASK_BENCH[OPUS55].usdPerTask, 'and dearer per task');
  assert.strictEqual(bestModel(), OPUS55);
});

test('a clearly better score would win over a small price difference, and Fable is never chosen', () => {
  const saved = { ...cost.TASK_BENCH };
  try {
    cost.TASK_BENCH[SONNET55] = { index: 75, usdPerTask: 14.2, minutesPerTask: 90 };
    assert.strictEqual(bestModel(), SONNET55, '9 points is not noise');
    cost.TASK_BENCH['claude-fable-5-1'] = { index: 99, usdPerTask: 1, minutesPerTask: 1 };
    assert.notStrictEqual(bestModel(), 'claude-fable-5-1');
  } finally {
    for (const k of Object.keys(cost.TASK_BENCH)) delete cost.TASK_BENCH[k];
    Object.assign(cost.TASK_BENCH, saved);
  }
});

test('the newest of each family is its cheapest per request', () => {
  assert.strictEqual(bestOf('opus'), OPUS55);
  assert.strictEqual(bestOf('sonnet'), SONNET55);
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

test('across families the saving is a share of each task', () => {
  const ratio = 13.0 / 14.2;
  const e = econ({ model: SONNET55, tokens: BIG, cacheTtl: '1h', target: OPUS55, taskRatio: ratio });
  assert.ok(Math.abs(e.targetPerRequestUsd - e.perRequestUsd * ratio) < 1e-12);
  assert.strictEqual(switchEconomics({ model: SONNET55, tokens: BIG, target: OPUS55 }), null, 'per token alone, Opus looks dearer');
});

test('compacting first is what makes a switch repay fast', () => {
  const after = econ({ model: OPUS5, tokens: 800000, cacheTtl: '1h' });
  const before = econ({ model: OPUS5, tokens: 800000, cacheTtl: '1h', compactFirst: false });
  assert.strictEqual(after.to, OPUS55, 'the target defaults to the best model');
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

// --- the prediction ---

test('every Sonnet goes to Opus 5.5, with the per-task reason', () => {
  const p = predictModel({ model: SONNET55, prompt: 'build the export pipeline' });
  assert.deepStrictEqual([p.want, p.dir, p.fromPrompt], [OPUS55, 'task', true]);
  assert.strictEqual(p.why, 'claude-opus-5-5 finishes a coding task for $13.04 vs $14.20 on claude-sonnet-5-5, in 1h vs 1.5h, scoring 66 vs 68 (Coding Agent Index, max effort)');
  const older = predictModel({ model: 'claude-sonnet-4-6', prompt: 'add a login page' });
  assert.strictEqual(older.want, OPUS55);
  assert.match(older.why, /on claude-sonnet-5-5, the newest Sonnet,/, 'an unbenchmarked model is compared through the newest of its family');
});

test('every older Opus goes to Opus 5.5, for the reason that is true', () => {
  // Opus 5 is measured: cheaper per task at max effort, but 6 points behind — beyond a tie.
  const q = predictModel({ model: OPUS5, prompt: 'why does this deadlock' });
  assert.deepStrictEqual([q.want, q.dir], [OPUS55, 'quality']);
  assert.strictEqual(q.why, 'claude-opus-5-5 scores 66 vs 60 for claude-opus-5 (Coding Agent Index) — a real gap — though a task costs $13.04 vs $10.79 (Coding Agent Index, max effort)');
  // The others were never measured: per-message price is all there is.
  for (const m of ['claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-1']) {
    const p = predictModel({ model: m, prompt: 'why does this deadlock' });
    assert.deepStrictEqual([p.want, p.dir, p.why], [OPUS55, 'same', `${OPUS55} is newer than ${m} and cheaper per message`], m);
  }
});

test('your own costs turn a quality move into a saving once there are enough', () => {
  const mine = { [OPUS5]: { tasks: 104, usdPerTask: 6.86 }, [OPUS55]: { tasks: 20, usdPerTask: 2.73 } };
  const p = predictModel({ model: OPUS5, prompt: 'build it all', observed: mine });
  assert.deepStrictEqual([p.dir, p.why], ['task', 'claude-opus-5-5 finishes a coding task for $2.73 vs $6.86 on claude-opus-5, median of your complex tasks (20 vs 104)']);
});

test('a quality move is held without a price argument, whatever the session size', () => {
  for (const tokens of [50000, 400000]) {
    const { hold } = advise({ model: OPUS5, tokens });
    assert.match(String(hold), /^\[rcskills\] Before this runs: claude-opus-5-5 scores 66 vs 60 for claude-opus-5 .*then \/model claude-opus-5-5, then send this again/, String(tokens));
    assert.doesNotMatch(String(hold), /per message/);
  }
});

test('the choice report says what decides and what is still missing', () => {
  assert.strictEqual(choiceReport({}), 'model choice: claude-opus-5-5, decided by the Coding Agent Index (max effort) until each contender has 15 complex tasks on your sessions (claude-sonnet-5-5 0/15, claude-opus-5-5 0/15) or 5 paired runs from rcskills compare (claude-sonnet-5-5 0/5, claude-opus-5-5 0/5)');
  const both = { [SONNET55]: { tasks: 40, usdPerTask: 2 }, [OPUS55]: { tasks: 15, usdPerTask: 3 } };
  assert.strictEqual(choiceReport(both), 'model choice: claude-sonnet-5-5, decided by your own task costs');
});

test('the size of the message decides only whether to hold it', () => {
  for (const prompt of ['what does this return?', 'fix the typo in the readme', 'thanks']) {
    const p = predictModel({ model: SONNET55, prompt });
    assert.deepStrictEqual([p.want, p.fromPrompt], [OPUS55, false], prompt);
  }
  for (const prompt of ['build the export pipeline', 'why does this deadlock', 'the other one too']) {
    assert.strictEqual(predictModel({ model: SONNET55, prompt }).fromPrompt, true, prompt);
  }
});

test('the best model, other families and unknown models get nothing', () => {
  for (const m of [OPUS55, 'claude-haiku-4-5', 'claude-fable-5-1', null, 'gpt-5', 'claude-opus-6']) {
    assert.strictEqual(predictModel({ model: m, prompt: 'build it' }).want, null, String(m));
  }
});

// --- the advice ---

test('the first task on Sonnet is held before it runs, with the order that keeps the reasoning', () => {
  const { hold } = advise();
  assert.ok(hold);
  assert.match(hold, /^\[rcskills\] Before this runs: claude-opus-5-5 finishes a coding task for \$13\.04 vs \$14\.20/);
  assert.match(hold, /\/compact keep decisions and open tasks for "build the export pipeline", then \/model claude-opus-5-5, then send this again/);
  assert.match(hold, /To stay on claude-sonnet-5-5, just send it again\./);
});

test('an unmeasured older Opus is held with per-message prices', () => {
  const { hold } = advise({ model: 'claude-opus-4-8' });
  assert.match(String(hold), /^\[rcskills\] Before this runs: claude-opus-5-5 is newer than claude-opus-4-8 and cheaper per message — \$0\.11 vs \$0\.19 per message\./);
});

test('a question is told, never held, and does not use up the hold', () => {
  const q = advise({ prompt: 'what does this return?' });
  assert.strictEqual(q.hold, null);
  assert.match(String(q.message), /^\[next\] End your reply with exactly this line: "Next: \/compact .*then \/model claude-opus-5-5 — claude-opus-5-5 finishes a coding task/);
  assert.ok(advise({ state: q.state }).hold, 'the task after it is still held');
});

test('every later message gets its line, and a model is held at most once', () => {
  const first = advise();
  assert.ok(first.hold);
  const again = advise({ state: first.state });
  assert.strictEqual(again.hold, null);
  assert.match(String(again.message), /then \/model claude-opus-5-5/);
  assert.strictEqual(advise({ state: again.state }).hold, null, 'never held twice');
  assert.ok(advise({ model: OPUS5, state: first.state }).hold, 'a new model starts again');
  assert.ok(advise({ state: first.state, sessionId: 's2' }).hold, 'another session is another conversation');
});

test('on the best model there is nothing to say', () => {
  for (const prompt of ['build the export pipeline', 'what is this?', 'continue']) {
    const r = advise({ model: OPUS55, prompt });
    assert.strictEqual(r.hold, null, prompt);
    assert.strictEqual(r.message, null, prompt);
  }
});

test('a small session saves too little to interrupt', () => {
  // A 9% task saving on a 50k session is ~$0.36 over a working session, under $0.50.
  assert.strictEqual(advise({ tokens: 50000 }).hold, null);
  assert.strictEqual(advise({ tokens: 50000 }).message, null);
});

test('a held message is handed back, because Claude Code erases it', () => {
  const prompt = 'build the export pipeline\nand its tests';
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

test('advise mode relays a line instead of holding', () => {
  const r = advise({ settings: { hold: false } });
  assert.strictEqual(r.hold, null);
  assert.match(r.message || '', /^\[next\] End your reply with exactly this line: "Next: \/compact keep .*, then \/model claude-opus-5-5 — /);
});

test('the budget is the dial, and nothing is said when it is off', () => {
  assert.strictEqual(advise({ settings: { budgetUsd: 100 } }).hold, null, 'a saving below the budget says nothing');
  assert.ok(advise({ settings: { budgetUsd: 0.05 } }).hold);
  assert.strictEqual(advise({ settings: { enabled: false } }).hold, null);
});

test('every figure in the advice is a real number', () => {
  for (const tokens of [200000, 1000000]) {
    for (const model of [OPUS5, SONNET55, 'claude-opus-4-1']) {
      const r = advise({ tokens, model });
      const text = r.hold || r.message;
      assert.ok(text, `${model} at ${tokens}`);
      assert.doesNotMatch(text, /NaN|Infinity|undefined|\$0\.00 vs/);
    }
  }
  assert.ok(MEDIAN_TURN_REQUESTS > 0);
});

// --- the user's own costs ---

test('your own task costs replace the benchmark once both models have enough', () => {
  const mine = { [SONNET55]: { tasks: 20, usdPerTask: 2 }, [OPUS55]: { tasks: 20, usdPerTask: 3 } };
  assert.strictEqual(bestModel(mine), SONNET55, 'on these sessions Sonnet is cheaper per task');
  const p = predictModel({ model: OPUS55, prompt: 'build the export pipeline', observed: mine });
  assert.deepStrictEqual([p.want, p.dir], [SONNET55, 'task']);
  assert.strictEqual(p.why, 'claude-sonnet-5-5 finishes a coding task for $2.00 vs $3.00 on claude-opus-5-5, median of your complex tasks (20 vs 20)');
});

test('too few local tasks, or only one model measured, leaves the benchmark in charge', () => {
  const few = { [SONNET55]: { tasks: 5, usdPerTask: 1 }, [OPUS55]: { tasks: 200, usdPerTask: 3 } };
  assert.strictEqual(bestModel(few), OPUS55);
  const p = predictModel({ model: SONNET55, prompt: 'build it all', observed: few });
  assert.match(p.why, /\(Coding Agent Index, max effort\)$/, 'never a mix of local and benchmark numbers');
});

test('a system notice is never held or advised: the user did not send it', () => {
  const notice = '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>';
  const r = advise({ prompt: notice });
  assert.strictEqual(r.hold, null);
  assert.strictEqual(r.message, null);
});

test('paired runs on the same tasks decide before anything else', () => {
  const mine = {
    [SONNET55]: { tasks: 30, usdPerTask: 9, paired: { tasks: 5, usdPerTask: 0.3 } },
    [OPUS55]: { tasks: 30, usdPerTask: 2, paired: { tasks: 6, usdPerTask: 0.5 } },
  };
  assert.strictEqual(bestModel(mine), SONNET55, 'controlled pairs outrank everyday costs');
  const p = predictModel({ model: OPUS55, prompt: 'build the export pipeline', observed: mine });
  assert.strictEqual(p.why, 'claude-sonnet-5-5 finishes a coding task for $0.30 vs $0.50 on claude-opus-5-5, median of 5 paired runs on your repo');
  assert.strictEqual(choiceReport(mine), 'model choice: claude-sonnet-5-5, decided by paired runs on your repo');
  const short = { [SONNET55]: { tasks: 0, usdPerTask: 0, paired: { tasks: 4, usdPerTask: 0.1 } }, [OPUS55]: { tasks: 0, usdPerTask: 0, paired: { tasks: 9, usdPerTask: 0.5 } } };
  assert.strictEqual(bestModel(short), OPUS55, 'four pairs are not enough');
});

test('only models your sessions have run are ever recommended', () => {
  const mine = { [SONNET55]: { tasks: 20, usdPerTask: 2 }, [OPUS55]: { tasks: 20, usdPerTask: 3 } };
  assert.strictEqual(bestModel(mine), SONNET55, 'unfiltered, the cheaper model wins');
  assert.strictEqual(bestModel(mine, [OPUS55, OPUS5]), OPUS55, 'but not one this Claude Code has never run');
  assert.strictEqual(bestModel(mine, ['claude-haiku-4-5']), null, 'no runnable contender: no advice');
  const p = predictModel({ model: OPUS55, prompt: 'build the export pipeline', observed: mine, available: [OPUS55] });
  assert.strictEqual(p.want, null, 'already on the only runnable contender');
  assert.strictEqual(choiceReport({}, [OPUS55]), 'model choice: claude-opus-5-5, the only contender your sessions can run (claude-sonnet-5-5 left out: never run in your sessions, so your Claude Code may not offer it)');
  assert.strictEqual(choiceReport({}, []), choiceReport({}), 'an empty list filters nothing');
});
