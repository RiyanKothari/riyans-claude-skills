'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { recentActivity } = require('./transcript.cjs');

function transcript(lines) {
  const p = path.join(os.tmpdir(), `activity-${Math.random()}.jsonl`);
  fs.writeFileSync(p, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return p;
}

const human = (content) => ({ type: 'user', promptSource: 'sdk', origin: { kind: 'human' }, message: { content } });
const tools = (...blocks) => ({ type: 'assistant', message: { content: blocks } });
const usage = (tokens, model = 'claude-opus-5') => ({
  type: 'assistant',
  message: { model, usage: { input_tokens: 0, cache_read_input_tokens: tokens } },
});
const bash = (command) => ({ type: 'tool_use', name: 'Bash', input: { command } });
const edit = (file) => ({ type: 'tool_use', name: 'Edit', input: { file_path: file } });

function phaseOf(lines, currentPrompt) {
  const p = transcript(lines);
  const a = recentActivity(p, { currentPrompt });
  fs.unlinkSync(p);
  assert.ok(a);
  return a;
}

test('context size and model come from the latest usage', () => {
  const a = phaseOf([human('go'), usage(300000, 'claude-sonnet-5')]);
  assert.strictEqual(a.tokens, 300000);
  assert.strictEqual(a.model, 'claude-sonnet-5');
});

test('usage from before a compaction does not count as current context', () => {
  // Found live: the first message after /compact was told the session held 941k.
  const boundary = { type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted' };
  const a = phaseOf([human('go'), usage(941000), boundary, human('continue')], 'continue');
  assert.strictEqual(a.tokens, 0);
  assert.strictEqual(a.model, 'claude-opus-5', 'the model is still known');
  const p = transcript([usage(941000), boundary]);
  assert.strictEqual(require('./transcript.cjs').lastContextUsage(p)?.tokens, 0);
  fs.unlinkSync(p);
  const after = phaseOf([usage(941000), boundary, human('continue'), usage(40000)]);
  assert.strictEqual(after.tokens, 40000, 'the first usage after compaction is the real size');
});

test('a turn that committed is a natural break', () => {
  assert.strictEqual(phaseOf([human('ship'), tools(edit('/a'), bash('git commit -m x')), usage(1)]).phase, 'boundary');
});

test('git options before the subcommand still count as a commit', () => {
  const lines = [human('ship'), tools(edit('/a'), bash('git -c user.name=x commit -q -m y')), usage(1)];
  assert.strictEqual(phaseOf(lines).phase, 'boundary');
});

test('a turn that edited without committing is mid-task', () => {
  assert.strictEqual(phaseOf([human('build'), tools(edit('/a'), bash('npm test')), usage(1)]).phase, 'working');
});

test('a turn that only answered is a natural break', () => {
  assert.strictEqual(phaseOf([human('explain it'), usage(1)]).phase, 'boundary');
});

test('a long investigation without edits is not called a break', () => {
  const lines = [human('debug'), tools(bash('ls'), bash('cat a'), bash('grep x .'), bash('npm test')), usage(1)];
  assert.strictEqual(phaseOf(lines).phase, 'unknown');
});

test('the prompt being submitted is not mistaken for the last turn', () => {
  const lines = [human('fix it'), tools(edit('/a')), usage(1), human('now what')];
  assert.strictEqual(phaseOf(lines, 'now what').phase, 'working');
});

test('no human turn in the tail gives an unknown phase', () => {
  assert.strictEqual(phaseOf([usage(5000)]).phase, 'unknown');
});

test('a missing transcript returns null rather than throwing', () => {
  assert.strictEqual(recentActivity(path.join(os.tmpdir(), `nope-${Math.random()}.jsonl`)), null);
});
