'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Runs the real per-prompt hook: the routing line is only useful if it reaches Claude
// in the directive form, from the session's own model.

const HOOK = path.join(__dirname, '..', '..', '.claude', 'helpers', 'learning-hook.cjs');

const human = (content) => ({ type: 'user', promptSource: 'sdk', origin: { kind: 'human' }, message: { content } });
// A long session by default: delegation only repays a subagent's fixed context there.
const usage = (model, tokens = 400000) => ({
  type: 'assistant', message: { model, usage: { input_tokens: 10, cache_read_input_tokens: tokens } },
});
const edit = (file) => ({
  type: 'assistant', message: { model: 'claude-opus-5', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: file } }] },
});

function session(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-hook-'));
  const tp = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(tp, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return { dir, tp, clean: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function recall(s, prompt, args = [], env = {}) {
  return spawnSync(process.execPath, [HOOK, 'recall', ...args], {
    cwd: s.dir,
    encoding: 'utf8',
    input: JSON.stringify({ prompt, transcript_path: s.tp, session_id: 'sess-router' }),
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: s.dir,
      TOKEN_HARNESS_CONFIG: path.join(s.dir, 'no-config.json'),
      TOKEN_HARNESS_COMPACT: 'off',
      SMART_MEMORY_PATH: '',
      TOKEN_HARNESS_MODEL_SWITCH: '',
      ...env,
    },
  }).stdout;
}

test('clear mechanical work gets a directive naming the pinned subagent', () => {
  const s = session([human('earlier'), usage('claude-opus-5')]);
  const out = recall(s, 'fix a typo in the readme');
  assert.match(out, /\[router\] delegate -> haiku/);
  assert.match(out, /subagent_type "rc-haiku"/);
  s.clean();
});

test('installed as a plugin, the directive names the namespaced subagent', () => {
  const s = session([human('earlier'), usage('claude-opus-5')]);
  // Claude Code names plugin agents <plugin>:<agent>; a bare "rc-haiku" would not resolve.
  // HOME points at the empty session dir, so no settings install makes the plugin stand down.
  const out = spawnSync(process.execPath, [HOOK, 'recall', '--plugin'], {
    cwd: s.dir,
    encoding: 'utf8',
    input: JSON.stringify({ prompt: 'fix a typo in the readme', transcript_path: s.tp, session_id: 'sess-router' }),
    env: {
      ...process.env, HOME: s.dir, USERPROFILE: s.dir, CLAUDE_PROJECT_DIR: s.dir,
      TOKEN_HARNESS_CONFIG: path.join(s.dir, 'no-config.json'), TOKEN_HARNESS_COMPACT: 'off', SMART_MEMORY_PATH: '',
    },
  }).stdout;
  assert.match(out, /subagent_type "rcskills:rc-haiku"/);
  s.clean();
});

test('a fresh session is not told to delegate, because it would cost more', () => {
  const s = session([human('earlier'), usage('claude-opus-5', 30000)]);
  assert.doesNotMatch(recall(s, 'fix a typo in the readme'), /\[router\]/);
  s.clean();
});

test('a vague work order is never delegated or escalated', () => {
  // A long Opus session may still hear what its model costs; that line is about the
  // session, not this prompt, so only delegation is ruled out here.
  const s = session([human('earlier'), usage('claude-opus-5')]);
  assert.doesNotMatch(recall(s, 'make it better'), /\[router\] (delegate|escalate)/);
  s.clean();
});

test('with session advice off, a sonnet session still hands reasoning-heavy work to an opus subagent', () => {
  const s = session([human('earlier'), usage('claude-sonnet-5')]);
  const out = recall(s, 'debug this intermittent race condition in the worker pool', [], { TOKEN_HARNESS_MODEL_SWITCH: 'off' });
  assert.match(out, /\[router\] escalate -> opus/);
  assert.match(out, /subagent_type "rc-opus"/);
  s.clean();
});

test('a stretch of proven small work on opus suggests /model sonnet, once', () => {
  const lines = [];
  for (let i = 0; i < 6; i++) lines.push(human(`small change ${i}`), edit(`/src/file${i}.js`));
  lines.push(usage('claude-opus-5'));
  const s = session(lines);
  assert.match(recall(s, 'next small thing'), /\/model sonnet/);
  assert.doesNotMatch(recall(s, 'another small thing'), /\/model sonnet/, 'once per session');
  s.clean();
});

test('mixed work on opus does not suggest switching', () => {
  // A price-only version of this rule told every large Opus session to move to Sonnet.
  // Replayed, following it would have run complex work on Sonnet ~43% of the time.
  const lines = [];
  for (let i = 0; i < 5; i++) lines.push(human(`small change ${i}`), edit(`/src/file${i}.js`));
  lines.push(human('big change'), ...[1, 2, 3, 4, 5].map((n) => edit(`/src/big${n}.js`)));
  lines.push(usage('claude-opus-5'));
  const s = session(lines);
  assert.doesNotMatch(recall(s, 'next'), /\/model sonnet/);
  s.clean();
});

test('a sonnet session is held before work that needs opus, once', () => {
  const s = session([human('earlier'), usage('claude-sonnet-5')]);
  const prompt = 'implement the export pipeline across the reporting service';
  const held = JSON.parse(recall(s, prompt));
  assert.strictEqual(held.decision, 'block');
  assert.match(held.reason, /needs Opus/);
  assert.match(held.reason, /\/model opus/);
  assert.doesNotMatch(recall(s, prompt), /"decision":"block"/, 'sending it again runs it on Sonnet');
  s.clean();
});

test('advise mode tells the user to switch instead of holding', () => {
  const s = session([human('earlier'), usage('claude-sonnet-5')]);
  const out = recall(s, 'implement the export pipeline across the reporting service', [], { TOKEN_HARNESS_MODEL_SWITCH: 'advise' });
  assert.doesNotMatch(out, /"decision":"block"/);
  assert.match(out, /the next work needs Opus/);
  assert.doesNotMatch(out, /escalate -> opus/, 'one instruction, not two');
  s.clean();
});
