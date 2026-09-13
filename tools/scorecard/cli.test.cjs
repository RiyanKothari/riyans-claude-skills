'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sessionTranscript, gatherTurnEvidence } = require('./cli.cjs');

const human = (content) => ({ type: 'user', promptSource: 'sdk', origin: { kind: 'human' }, message: { content } });
const wrote = (file) => ({
  type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: file } }] },
});

function projects() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scorecard-projects-'));
  const put = (dir, id, lines) => {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    const p = path.join(root, dir, `${id}.jsonl`);
    fs.writeFileSync(p, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    return p;
  };
  return { root, put, clean: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('evidence comes from this session, even when another project wrote last', () => {
  // Found live: another project's session was newest, its turn had no tests or
  // docs, and a turn that shipped three test files and a SKILL.md scored durability 0.
  const p = projects();
  const mine = p.put('C--work-harness', 'sess-mine', [
    human('add the loop'), wrote('/r/tools/loop.test.cjs'), wrote('/r/skills/x/SKILL.md'),
  ]);
  const other = p.put('C--work-other', 'sess-other', [human('unrelated'), wrote('/o/main.py')]);
  const later = new Date(Date.now() + 60000);
  fs.utimesSync(other, later, later);

  const found = sessionTranscript({ CLAUDE_CODE_SESSION_ID: 'sess-mine' }, p.root);
  assert.strictEqual(found, mine);
  const ev = gatherTurnEvidence(found);
  assert.strictEqual(ev.testsAdded, 1);
  assert.strictEqual(ev.docsUpdated, true);
  p.clean();
});

test('outside a session the turn evidence stays unmeasured rather than guessed', () => {
  const p = projects();
  p.put('C--work-other', 'sess-other', [human('unrelated'), wrote('/o/a.test.js')]);
  assert.strictEqual(sessionTranscript({}, p.root), null);
  assert.strictEqual(sessionTranscript({ CLAUDE_CODE_SESSION_ID: 'no-such-session' }, p.root), null);
  p.clean();
});

test('a hostile session id cannot select another file', () => {
  const p = projects();
  p.put('C--work-other', 'victim', [human('x')]);
  assert.strictEqual(sessionTranscript({ CLAUDE_CODE_SESSION_ID: '../C--work-other/victim' }, p.root), null);
  p.clean();
});
