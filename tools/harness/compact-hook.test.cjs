'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Exercises the real per-prompt hook against a fake transcript, because that is
// the only place a long session's growth is ever noticed mid-session.

const HOOK = path.join(__dirname, '..', '..', '.claude', 'helpers', 'learning-hook.cjs');

function project(tokens) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-hook-'));
  const tp = path.join(dir, 'transcript.jsonl');
  const line = {
    type: 'assistant',
    message: { model: 'claude-opus-5', usage: { input_tokens: 10, cache_read_input_tokens: tokens } },
  };
  fs.writeFileSync(tp, `${JSON.stringify(line)}\n`);
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
      TOKEN_HARNESS_COMPACT_REMIND: '',
      ...env,
    },
  });
}

test('a long session gets a compaction prompt on its next message', () => {
  const p = project(300000);
  const out = recall(p).stdout;
  assert.match(out, /\[context\] 300k tokens in this session/);
  assert.match(out, /per request to re-read/, 'cost is priced from the model in the transcript');
  p.clean();
});

test('a short session stays silent', () => {
  const p = project(50000);
  assert.doesNotMatch(recall(p).stdout, /\[context\]/);
  p.clean();
});

test('the prompt does not repeat on every message', () => {
  const p = project(300000);
  assert.match(recall(p).stdout, /\[context\]/);
  assert.doesNotMatch(recall(p).stdout, /\[context\]/, 'the next message at the same size stays quiet');
  p.clean();
});

test('the setting can switch prompts off', () => {
  const p = project(900000);
  assert.doesNotMatch(recall(p, { TOKEN_HARNESS_COMPACT: 'off' }).stdout, /\[context\]/);
  p.clean();
});

test('the setting can lower the threshold', () => {
  const p = project(90000);
  assert.match(recall(p, { TOKEN_HARNESS_COMPACT: '80000' }).stdout, /\[context\]/);
  p.clean();
});
