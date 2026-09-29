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
  // The Opus 5 session's own switch advice would hold this message first.
  const out = recall(s, 'fix a typo in the readme', [], { TOKEN_HARNESS_MODEL_SWITCH: 'off' });
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
      TOKEN_HARNESS_CONFIG: path.join(s.dir, 'no-config.json'), TOKEN_HARNESS_COMPACT: 'off', SMART_MEMORY_PATH: '', TOKEN_HARNESS_MODEL_SWITCH: 'off',
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

test('an older Opus session is told to move to Opus 5.5 on every message, held only once', () => {
  const s = session([human('earlier'), usage('claude-opus-5')]);
  const held = JSON.parse(recall(s, 'next small thing'));
  assert.strictEqual(held.decision, 'block');
  assert.match(held.reason, /claude-opus-5-5 is newer and cheaper than claude-opus-5/);
  assert.match(held.reason, /then \/model claude-opus-5-5, then send this again/);
  const later = recall(s, 'another small thing');
  assert.match(later, /^\[next\] .*\/model claude-opus-5-5/m, 'prompted again after the next message');
  assert.doesNotMatch(later, /"decision":"block"/, 'but never held twice');
  s.clean();
});

test('Opus 5.5 is left alone for real work; Sonnet is held before it', () => {
  const opus = session([human('earlier'), usage('claude-opus-5-5')]);
  assert.doesNotMatch(recall(opus, 'implement the export pipeline across the reporting service'), /"decision":"block"|\/model /);
  opus.clean();
  const sonnet = session([human('earlier'), usage('claude-sonnet-5-5')]);
  const held = JSON.parse(recall(sonnet, 'implement the export pipeline across the reporting service'));
  assert.strictEqual(held.decision, 'block');
  assert.match(held.reason, /needs Opus .*\/model claude-opus-5-5/);
  const later = recall(sonnet, 'implement the export pipeline across the reporting service');
  assert.match(later, /^\[next\] .*Before your next message: \/model claude-opus-5-5/m, 'the next message is prompted too');
  assert.doesNotMatch(later, /escalate -> opus/, 'one instruction, not two');
  sonnet.clean();
});

test('advise mode tells the user to switch instead of holding', () => {
  const s = session([human('earlier'), usage('claude-opus-4-8')]);
  const out = recall(s, 'what does this return?', [], { TOKEN_HARNESS_MODEL_SWITCH: 'advise' });
  assert.doesNotMatch(out, /"decision":"block"/);
  assert.match(out, /^\[next\] .*then \/model claude-opus-5-5 — claude-opus-5-5 is newer and cheaper than claude-opus-4-8/m);
  s.clean();
});
