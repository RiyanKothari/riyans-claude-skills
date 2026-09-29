'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const createAdvice = require('./hook-advice.cjs');

process.env.TOKEN_HARNESS_CONFIG = path.join(os.tmpdir(), 'hook-advice-test-no-config.json');
delete process.env.TOKEN_HARNESS_MODEL_SWITCH;
delete process.env.TOKEN_HARNESS_COMPACT;

/**
 * The advice module with the hook's helpers injected, and state in a throwaway dir.
 * @param {any} [activity]
 */
function env(activity = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-advice-'));
  const p = (f) => path.join(dir, f);
  const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const advice = createAdvice({
    req: (rel) => require(path.join(__dirname, rel)),
    readJsonFile: read,
    writeJsonFile: (f, v) => fs.writeFileSync(f, JSON.stringify(v)),
    sessionActivity: () => activity,
    AGENT_PREFIX: '',
    MAX_NEIGHBORS: 5,
    paths: {
      COMPACT_STATE: p('compact.json'), SWITCH_STATE: p('switch.json'), SWITCH_HANDOFF: p('handoff-switch.json'),
      GUARD_STATE: p('guard.json'), NOTICE_STATE: p('notice.json'), HANDOFF: p('handoff.json'),
    },
  });
  return { advice, dir, read, p, clean: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const small = { edits: 1, commands: 1, reads: 1, distinctFiles: 1 };

test('the compaction line names the work in hand and remembers it was said', () => {
  const e = env();
  const activity = { tokens: 500000, model: 'claude-opus-5', handoff: { prompts: ['earlier ask'] } };
  const line = e.advice.compactPrompt(500000, { session_id: 's' }, activity, { focus: 'the export' });
  assert.match(line, /^\[next\] .*\/compact keep decisions and open tasks for "the export"/);
  assert.strictEqual(e.read(e.p('compact.json')).advisedAt, 500000);
  assert.match(e.advice.compactPrompt(900000, { session_id: 't' }, activity), /for "earlier ask"/, 'falls back to the last ask');
  const followUp = { ...activity, handoff: { prompts: ['build the export step', 'how do you want to proceed'] } };
  assert.match(e.advice.compactPrompt(900000, { session_id: 'u' }, followUp), /for "build the export step"/, 'names the work, not the follow-up');
  // A background task finishing arrives as a prompt; it is never the work in hand.
  const notice = '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>';
  const noticeLine = e.advice.compactPrompt(900000, { session_id: 'v' }, followUp, { focus: notice });
  assert.match(noticeLine, /for "build the export step"/);
  assert.doesNotMatch(noticeLine, /task-notification/);
  e.clean();
});

test('model advice moves an older Opus to Opus 5.5, and the handoff survives the switch', () => {
  const activity = {
    tokens: 150000, model: 'claude-opus-5', recent: [small],
    handoff: { prompts: ['build it'], files: [], lastText: 'Planned.', thinking: ['Stream, do not buffer.'], todos: ['write the writer'] },
  };
  const e = env(activity);
  const held = e.advice.modelSwitchAdvice(activity, { session_id: 's' }, 'why does the export pipeline hang');
  assert.match(held.hold, /\/model claude-opus-5-5/);

  // Reasoning is bound to the exact model, so an Opus-to-Opus switch strands it too.
  e.advice.captureSwitchHandoff({ session_id: 's', from_model: 'claude-opus-5', to_model: 'claude-opus-5-5' });
  const line = e.advice.switchHandoffLine({ session_id: 's' });
  assert.match(line, /\[handoff\].*Stream, do not buffer\..*write the writer/);
  assert.strictEqual(e.advice.switchHandoffLine({ session_id: 's' }), null, 'once');
  e.clean();
});

test('nothing to say without a session to say it about', () => {
  const e = env(null);
  assert.deepStrictEqual(e.advice.cacheLines({}, null, false), []);
  assert.strictEqual(e.advice.coldCacheBlock({}, 'hi', null), null);
  assert.deepStrictEqual(e.advice.modelSwitchAdvice(null, {}, 'hi'), { message: null, hold: null });
  e.clean();
});
