'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { relay, compactCommand, compactLine, modelSwitchLine, modelUpLine } = require('./next-command.cjs');

test('the directive asks for the finished line, word for word, as the last line', () => {
  assert.strictEqual(relay('Next: /compact'), '[next] End your reply with exactly this line: "Next: /compact"');
  assert.strictEqual(relay(null), null);
});

test('/compact names the work in hand, clipped, without breaking the quoting', () => {
  assert.strictEqual(compactCommand('build the "export" step'), `/compact keep decisions and open tasks for "build the 'export' step"`);
  assert.strictEqual(compactCommand(''), '/compact keep decisions and open tasks');
  assert.ok(compactCommand('x'.repeat(400)).length < 110);
});

test('each line is one short sentence with the command first', () => {
  const lines = [
    compactLine({ tokens: 360000, perRequestUsd: 0.18, focus: 'improve the score' }),
    modelSwitchLine({ focus: 'what does this return?', to: 'claude-sonnet-5-5', why: 'the last 3 turns were small', fromUsd: 0.11, toUsd: 0.08 }),
    modelUpLine({ to: 'claude-opus-5-5', why: 'it starts new work' }),
  ];
  assert.match(lines[0], /^Next: \/compact keep decisions and open tasks for "improve the score" — 360k of context, \$0\.18 per message to re-read\.$/);
  assert.match(lines[1], /^Next: \/compact keep .*, then \/model claude-sonnet-5-5 — the last 3 turns were small; \$0\.08 vs \$0\.11 per message\.$/);
  assert.strictEqual(lines[2], 'Before your next message: /model claude-opus-5-5 — it starts new work.');
  for (const l of lines) {
    const r = relay(l);
    assert.ok(r && r.length <= 260, `${r && r.length} chars: ${l}`);
  }
});

test('an unknown cost is left out rather than printed as nothing', () => {
  assert.strictEqual(compactLine({ tokens: 200000, focus: '' }), 'Next: /compact keep decisions and open tasks — 200k of context.');
});
