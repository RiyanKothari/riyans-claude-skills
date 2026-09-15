'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { followThrough } = require('./delegation.cjs');

const human = (content) => ({ type: 'user', promptSource: 'sdk', origin: { kind: 'human' }, message: { content } });
const hookNote = (content) => ({ type: 'attachment', attachment: { type: 'hook_success', content } });
const agent = (input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', input }] } });
const toolOutput = (text) => ({
  type: 'user', toolUseResult: {}, message: { content: [{ type: 'tool_result', content: text }] },
});

function file(lines) {
  const p = path.join(os.tmpdir(), `follow-${Math.random()}.jsonl`);
  fs.writeFileSync(p, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return p;
}

const DIRECTIVE = '[router] delegate -> haiku (trivial, score -2; ~89% cheaper than claude-opus-5). Call the Agent tool';

test('a routed turn counts as followed only when the named model was used', () => {
  const p = file([
    human('fix a typo'), hookNote(DIRECTIVE), agent({ subagent_type: 'rc-haiku', prompt: 'x' }),
    human('rename foo'), hookNote(DIRECTIVE), agent({ subagent_type: 'general-purpose', prompt: 'x' }),
    human('bump version'), hookNote(DIRECTIVE),
  ]);
  const r = followThrough([p]);
  assert.strictEqual(r.routed, 3);
  assert.strictEqual(r.followed, 1);
  assert.strictEqual(r.agentCalls, 2);
  assert.deepStrictEqual(r.byModel, { haiku: 1, '(inherit)': 1 });
  fs.unlinkSync(p);
});

test('the older advisory note format is still measured', () => {
  const p = file([
    human('fix a typo'),
    hookNote('[router] simple (conf 0.33). Mechanical subtasks -> Agent tool model:"haiku", ~88.8% cheaper. Inline if it needs repo context.'),
    agent({ model: 'haiku', prompt: 'x' }),
  ]);
  const r = followThrough([p]);
  assert.strictEqual(r.routed, 1);
  assert.strictEqual(r.followed, 1);
  fs.unlinkSync(p);
});

test('router text inside tool output is not mistaken for a routing decision', () => {
  const p = file([human('grep the hook'), toolOutput(DIRECTIVE)]);
  assert.strictEqual(followThrough([p]).routed, 0);
  fs.unlinkSync(p);
});
