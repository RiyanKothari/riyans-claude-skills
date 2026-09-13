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
      CLAUDE_PROJECT_DIR: p.dir,
      TOKEN_HARNESS_CONFIG: path.join(p.dir, 'no-config.json'),
      TOKEN_HARNESS_COMPACT: '',
      TOKEN_HARNESS_COMPACT_BUDGET: '',
      TOKEN_HARNESS_COMPACT_REMIND: '',
      ...env,
    },
  }).stdout;
}

const commit = { type: 'tool_use', name: 'Bash', input: { command: 'git commit -m "ship"' } };
const edit = { type: 'tool_use', name: 'Edit', input: { file_path: '/a.js' } };

test('a long session gets a prompt that says where the prompt point is', () => {
  const p = project(500000);
  const out = recall(p);
  assert.match(out, /\[context\] 500k tokens in this session/);
  assert.match(out, /prompt point \d+k/);
  assert.match(out, /per request to re-read/, 'cost is priced from the model in the transcript');
  p.clean();
});

test('a short session stays silent', () => {
  const p = project(50000);
  assert.doesNotMatch(recall(p), /\[context\]/);
  p.clean();
});

test('the prompt does not repeat on every message', () => {
  const p = project(500000);
  assert.match(recall(p), /\[context\]/);
  assert.doesNotMatch(recall(p), /\[context\]/, 'the next message at the same size stays quiet');
  p.clean();
});

test('a cheaper model is allowed to grow further before the prompt', () => {
  const opus = project(350000, { model: 'claude-opus-5' });
  const sonnet = project(350000, { model: 'claude-sonnet-5' });
  assert.match(recall(opus), /\[context\]/);
  assert.doesNotMatch(recall(sonnet), /\[context\]/);
  opus.clean();
  sonnet.clean();
});

test('a turn that just committed prompts sooner than one left mid-edit', () => {
  const atBreak = project(260000, { lastTurn: [edit, commit] });
  const midTask = project(260000, { lastTurn: [edit] });
  assert.match(recall(atBreak), /\[context\].*natural break/);
  assert.doesNotMatch(recall(midTask), /\[context\]/);
  atBreak.clean();
  midTask.clean();
});

test('the setting can switch prompts off', () => {
  const p = project(900000);
  assert.doesNotMatch(recall(p, { TOKEN_HARNESS_COMPACT: 'off' }), /\[context\]/);
  p.clean();
});

test('a fixed threshold can still be chosen', () => {
  const p = project(90000);
  assert.match(recall(p, { TOKEN_HARNESS_COMPACT: '80000' }), /\[context\].*fixed threshold/);
  p.clean();
});
