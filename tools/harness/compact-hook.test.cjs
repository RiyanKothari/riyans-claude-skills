'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Exercises the real per-prompt hook against fake transcripts, because that is
// the only place a session's growth is noticed mid-session.

const HOOK = path.join(__dirname, '..', '..', '.claude', 'helpers', 'learning-hook.cjs');

const human = (content) => ({ type: 'user', promptSource: 'sdk', origin: { kind: 'human' }, message: { content } });
const toolTurn = (...blocks) => ({ type: 'assistant', message: { content: blocks } });
const usage = (tokens, model) => ({
  type: 'assistant',
  message: { model, usage: { input_tokens: 10, cache_read_input_tokens: tokens } },
});

/**
 * @param {number} tokens
 * @param {{model?: string, lastTurn?: object[]|null}} [opts]
 */
function project(tokens, opts = {}) {
  const { model = 'claude-opus-5', lastTurn = null } = opts;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-hook-'));
  const tp = path.join(dir, 'transcript.jsonl');
  const lines = [];
  if (lastTurn) lines.push(human('previous task'), toolTurn(...lastTurn));
  lines.push(usage(tokens, model));
  fs.writeFileSync(tp, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return { dir, tp, clean: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function recall(p, env = {}) {
  return spawnSync(process.execPath, [HOOK, 'recall'], {
    cwd: p.dir,
    encoding: 'utf8',
    input: JSON.stringify({
      prompt: 'design the payment retry architecture',
      transcript_path: p.tp,
      session_id: 'sess-1',
    }),
    env: {
      ...process.env,
      HOME: p.dir,
      USERPROFILE: p.dir,
      CLAUDE_PROJECT_DIR: p.dir,
      TOKEN_HARNESS_CONFIG: path.join(p.dir, 'no-config.json'),
      TOKEN_HARNESS_COMPACT: '',
      // An Opus 5 session is also told to move to Opus 5.5; that advice has its own tests.
      TOKEN_HARNESS_MODEL_SWITCH: 'off',
      TOKEN_HARNESS_COMPACT_BUDGET: '',
      TOKEN_HARNESS_COMPACT_REMIND: '',
      ...env,
    },
  }).stdout;
}

const commit = { type: 'tool_use', name: 'Bash', input: { command: 'git commit -m "ship"' } };
const edit = { type: 'tool_use', name: 'Edit', input: { file_path: '/a.js' } };

// The compaction line itself: a cache line is also a [next] line, so a bare tag would match it.
const COMPACT_LINE = /\/compact keep decisions/;

test('a long session gets a finished /compact line naming the work in hand', () => {
  const p = project(500000);
  const out = recall(p);
  assert.match(out, /\[next\] End your reply with exactly this line: "Next: \/compact keep decisions and open tasks for "design the payment retry architecture" — 500k of context/);
  assert.match(out, /per message to re-read/, 'cost is priced from the model in the transcript');
  p.clean();
});

test('a short session stays silent', () => {
  const p = project(50000);
  assert.doesNotMatch(recall(p), COMPACT_LINE);
  p.clean();
});

test('the prompt does not repeat on every message', () => {
  const p = project(500000);
  assert.match(recall(p), COMPACT_LINE);
  assert.doesNotMatch(recall(p), COMPACT_LINE, 'the next message at the same size stays quiet');
  p.clean();
});

test('a cheaper model is allowed to grow further before the prompt', () => {
  const opus = project(350000, { model: 'claude-opus-5' });
  const sonnet = project(350000, { model: 'claude-sonnet-5' });
  assert.match(recall(opus), COMPACT_LINE);
  assert.doesNotMatch(recall(sonnet), COMPACT_LINE);
  opus.clean();
  sonnet.clean();
});

test('a turn that just committed prompts sooner than one left mid-edit', () => {
  const atBreak = project(260000, { lastTurn: [edit, commit] });
  const midTask = project(260000, { lastTurn: [edit] });
  assert.match(recall(atBreak), COMPACT_LINE);
  assert.doesNotMatch(recall(midTask), COMPACT_LINE);
  atBreak.clean();
  midTask.clean();
});

test('the setting can switch prompts off', () => {
  const p = project(900000);
  assert.doesNotMatch(recall(p, { TOKEN_HARNESS_COMPACT: 'off' }), COMPACT_LINE);
  p.clean();
});

test('a fixed threshold can still be chosen', () => {
  const p = project(90000);
  assert.match(recall(p, { TOKEN_HARNESS_COMPACT: '80000' }), COMPACT_LINE);
  p.clean();
});
