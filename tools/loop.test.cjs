'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const loop = require('./loop.cjs');
const { hookCommand } = require('../bin/harness.js');

const ROOT = path.join(__dirname, '..');
const HOOK = path.join(ROOT, '.claude', 'helpers', 'learning-hook.cjs');

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-'));
  const env = {
    ...process.env,
    TOKEN_HARNESS_LOOP_DIR: path.join(dir, 'loops'),
    CLAUDE_CODE_SESSION_ID: 'sess-a',
    CLAUDE_PROJECT_DIR: dir,
  };
  return { dir, env, clean: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function transcript(dir, lines) {
  const p = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(p, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return p;
}

const later = () => new Date(Date.now() + 1000).toISOString();
const said = (text, timestamp = later()) => ({
  type: 'assistant', timestamp, message: { content: [{ type: 'text', text }] },
});
const toolResult = (text) => ({
  type: 'user', timestamp: later(), message: { content: [{ type: 'tool_result', content: text }] },
});

test('arguments default to a 10-iteration cap and reject unbounded loops', () => {
  const a = loop.parseArgs(['fix', 'the', 'tests']);
  assert.strictEqual(a.prompt, 'fix the tests');
  assert.strictEqual(a.max, 10);
  assert.deepStrictEqual(a.errors, []);
  assert.ok(loop.parseArgs(['x', '--max-iterations', '0']).errors.length, '0 would mean unlimited');
  assert.ok(loop.parseArgs(['x', '--max-iterations', 'ten']).errors.length);
  assert.ok(loop.parseArgs(['x', '--max-iterations', '101']).errors.length);
  assert.ok(loop.parseArgs(['--max-iterations', '5']).errors.length, 'a prompt is required');
});

test('a multi-word promise is kept whole and whitespace-normalised', () => {
  assert.strictEqual(loop.parseArgs(['ship', '--completion-promise', '  ALL   TESTS PASS ']).promise, 'ALL TESTS PASS');
});

test('a loop can only start inside a Claude Code session', () => {
  const s = sandbox();
  const r = loop.start(['do it'], { ...s.env, CLAUDE_CODE_SESSION_ID: '' });
  assert.strictEqual(r.state, null);
  assert.match(r.errors.join(' '), /CLAUDE_CODE_SESSION_ID/);
  s.clean();
});

test('no active loop lets the session stop', () => {
  const s = sandbox();
  assert.strictEqual(loop.decideStop({ session_id: 'sess-a' }, s.env), null);
  s.clean();
});

test('a stop re-feeds the same prompt and counts the iteration', () => {
  const s = sandbox();
  loop.start(['make the suite green', '--max-iterations', '3'], s.env);
  const tp = transcript(s.dir, [said('still failing')]);
  const d = loop.decideStop({ session_id: 'sess-a', transcript_path: tp }, s.env);
  assert.strictEqual(d?.block?.decision, 'block');
  assert.strictEqual(d?.block?.reason, 'make the suite green');
  assert.match(String(d?.block?.systemMessage), /iteration 2\/3/);
  assert.strictEqual(loop.readState('sess-a', s.env).iteration, 2);
  s.clean();
});

test('another session in the same project is never blocked', () => {
  const s = sandbox();
  loop.start(['work'], s.env);
  assert.strictEqual(loop.decideStop({ session_id: 'sess-b' }, s.env), null);
  s.clean();
});

test('the cap ends the loop and removes its state', () => {
  const s = sandbox();
  loop.start(['work', '--max-iterations', '1'], s.env);
  const d = loop.decideStop({ session_id: 'sess-a' }, s.env);
  assert.match(String(d?.stop), /cap of 1 iteration/);
  assert.strictEqual(loop.readState('sess-a', s.env), null);
  s.clean();
});

test('a true completion promise from this iteration ends the loop', () => {
  const s = sandbox();
  loop.start(['work', '--completion-promise', 'ALL TESTS PASS'], s.env);
  const tp = transcript(s.dir, [said('Verified.\n<promise> ALL TESTS\n PASS </promise>')]);
  const d = loop.decideStop({ session_id: 'sess-a', transcript_path: tp }, s.env);
  assert.match(String(d?.stop), /ALL TESTS PASS/);
  assert.strictEqual(loop.readState('sess-a', s.env), null);
  s.clean();
});

test('the promise only counts when Claude itself says it in this iteration', () => {
  const s = sandbox();
  loop.start(['work', '--completion-promise', 'DONE'], s.env);
  const tp = transcript(s.dir, [
    said('<promise>DONE</promise>', '2000-01-01T00:00:00.000Z'), // before this iteration began
    toolResult('Finish by writing <promise>DONE</promise>'), // the start instructions quote it
    said('<promise>NOT DONE</promise>'),
  ]);
  const d = loop.decideStop({ session_id: 'sess-a', transcript_path: tp }, s.env);
  assert.strictEqual(d?.block?.decision, 'block');
  s.clean();
});

test('corrupt loop state ends the loop instead of blocking forever', () => {
  const s = sandbox();
  loop.start(['work'], s.env);
  const p = String(loop.statePath('sess-a', s.env));
  fs.writeFileSync(p, '{"iteration":"two"');
  const d = loop.decideStop({ session_id: 'sess-a' }, s.env);
  assert.match(String(d?.stop), /unreadable/);
  assert.ok(!fs.existsSync(p));
  s.clean();
});

test('a hostile session id cannot escape the loop directory', () => {
  const s = sandbox();
  assert.strictEqual(path.dirname(String(loop.statePath('../../etc/passwd', s.env))), path.join(s.dir, 'loops'));
  s.clean();
});

function hook(s, input) {
  return spawnSync(process.execPath, [HOOK, 'loop'], {
    input: JSON.stringify(input), cwd: s.dir, encoding: 'utf8', env: s.env,
  });
}

test('the real hook script blocks the stop with the prompt', () => {
  const s = sandbox();
  loop.start(['keep going'], s.env);
  const out = JSON.parse(hook(s, { session_id: 'sess-a' }).stdout);
  assert.strictEqual(out.decision, 'block');
  assert.strictEqual(out.reason, 'keep going');
  s.clean();
});

test('the real hook script is silent when no loop is running', () => {
  const s = sandbox();
  assert.strictEqual(hook(s, { session_id: 'sess-a' }).stdout.trim(), '');
  s.clean();
});

// Exit code proves nothing for a hook; run the installed command through bash and read its output.
const bashCanRunNode = spawnSync('bash', ['-c', 'node --version'], { encoding: 'utf8' }).status === 0;

test('the installed loop hook command runs through bash', { skip: !bashCanRunNode }, () => {
  const s = sandbox();
  loop.start(['keep going'], s.env);
  const r = spawnSync('bash', ['-c', hookCommand('loop')], {
    input: JSON.stringify({ session_id: 'sess-a' }), cwd: s.dir, encoding: 'utf8', env: s.env,
  });
  assert.match(r.stdout, /"decision":"block"/, `hook did not run: ${r.stdout}${r.stderr}`);
  s.clean();
});

test('rcskills loop start, status and cancel work from any project', () => {
  const s = sandbox();
  const cli = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'bin', 'harness.js'), 'loop', ...args], {
    cwd: s.dir, encoding: 'utf8', env: s.env,
  });
  const started = cli('start', 'fix', 'lint', '--completion-promise', 'LINT CLEAN');
  assert.strictEqual(started.status, 0, started.stderr);
  assert.match(started.stdout, /<promise>LINT CLEAN<\/promise>/);
  assert.match(cli('status').stdout, /iteration 1\/10/);
  assert.strictEqual(cli('cancel').status, 0);
  assert.match(cli('status').stdout, /no active loop/);
  assert.ok(!fs.existsSync(path.join(s.dir, '.claude')), 'nothing is written into the project');
  s.clean();
});
