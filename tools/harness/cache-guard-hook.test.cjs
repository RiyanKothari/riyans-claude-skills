'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Runs the real per-prompt and session-start hooks: a hold only saves money if
// Claude Code receives a well-formed block, and /clear only loses nothing if the
// next session is handed the summary.

const HOOK = path.join(__dirname, '..', '..', '.claude', 'helpers', 'learning-hook.cjs');
const HOUR = 3600000;

const human = (content) => ({ type: 'user', promptSource: 'sdk', origin: { kind: 'human' }, message: { content } });
const reply = (ago, tokens, extra = []) => ({
  type: 'assistant',
  timestamp: new Date(Date.now() - ago).toISOString(),
  message: {
    model: 'claude-opus-5',
    content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/repo/src/report.js' } }, ...extra],
    usage: {
      input_tokens: 10,
      cache_read_input_tokens: tokens,
      cache_creation_input_tokens: 1000,
      cache_creation: { ephemeral_1h_input_tokens: 1000, ephemeral_5m_input_tokens: 0 },
    },
  },
});

function session(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-guard-hook-'));
  const tp = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(tp, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return { dir, tp, clean: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function run(s, mode, input, env = {}) {
  return spawnSync(process.execPath, [HOOK, mode], {
    cwd: s.dir,
    encoding: 'utf8',
    input: JSON.stringify({ transcript_path: s.tp, session_id: 'sess-guard', ...input }),
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: s.dir,
      TOKEN_HARNESS_CONFIG: path.join(s.dir, 'no-config.json'),
      TOKEN_HARNESS_COMPACT: 'off',
      TOKEN_HARNESS_CACHE_GUARD: '',
      SMART_MEMORY_PATH: '',
      ...env,
    },
  }).stdout;
}

test('in block mode a prompt into an expired 400k session is held once, and /clear gets a handoff', () => {
  const s = session([
    human('build the quarterly report'),
    // 398,990 read + 1,000 written + 10 fresh = a 400k context.
    reply(3 * HOUR, 398990, [{ type: 'text', text: 'Report built and committed.' }]),
  ]);

  const out = run(s, 'recall', { prompt: 'now add a chart' }, { TOKEN_HARNESS_CACHE_GUARD: 'block' });
  const decision = JSON.parse(out.trim());
  assert.strictEqual(decision.decision, 'block');
  assert.match(decision.reason, /\[cache\] Not sent: .*expired 3h 0m ago.*400k tokens on claude-opus-5 \(~\$4\.00\)/);

  const again = run(s, 'recall', { prompt: 'now add a chart' }, { TOKEN_HARNESS_CACHE_GUARD: 'block' });
  assert.doesNotMatch(again, /"decision"/, 'sending again must go through');

  const start = run(s, 'core', { source: 'clear' });
  assert.match(start, /\[last session 0h ago\] recent asks: "build the quarterly report"; files edited: src\/report\.js; last reply: "Report built and committed\."/);
  s.clean();
});

test('a warm session is never blocked', () => {
  const s = session([human('build it'), reply(10 * 60000, 400000)]);
  assert.doesNotMatch(run(s, 'recall', { prompt: 'next step' }), /"decision"/);
  s.clean();
});

test('the guard can be switched off per project', () => {
  const s = session([human('build it'), reply(3 * HOUR, 400000)]);
  assert.doesNotMatch(run(s, 'recall', { prompt: 'next step' }, { TOKEN_HARNESS_CACHE_GUARD: 'off' }), /"decision"/);
  assert.doesNotMatch(run(s, 'recall', { prompt: 'later' }, { TOKEN_HARNESS_CACHE_GUARD: 'off' }), /\[cache\]/);
  s.clean();
});

test('the handoff never stores a secret from the transcript', () => {
  const secret = ['sk', 'ant', 'api03', 'A'.repeat(40)].join('-');
  const s = session([human(`use key ${secret} for the deploy`), reply(3 * HOUR, 400000)]);
  run(s, 'recall', { prompt: 'deploy it' }, { TOKEN_HARNESS_CACHE_GUARD: 'block' });
  const handoff = fs.readFileSync(path.join(s.dir, '.claude', 'memory', 'handoff.json'), 'utf8');
  assert.doesNotMatch(handoff, /AAAAAAAAAAAAAAAAAAAA/);
  s.clean();
});

test('by default no message is held; Claude is asked to end its reply with the cache line', () => {
  const s = session([
    human('build the quarterly report'),
    reply(1000, 398990, [{ type: 'text', text: 'Report built.' }]),
  ]);
  const out = run(s, 'recall', { prompt: 'next' });
  assert.doesNotMatch(out, /"decision"/);
  assert.match(out, /^\[cache\] End your reply with this line for the user: "400k tokens cached\. Reply within 30 min to keep it cheap; after that your next message re-sends it all \(~\$4\.00\)\. Stepping away\? \/compact first, or \/clear \(~\$0\.56, keeps a summary\)\."$/m);
  assert.doesNotMatch(run(s, 'recall', { prompt: 'and then' }), /\[cache\]/, 'not repeated within 15 minutes');

  // The desktop app does not show a Stop hook's output, so it prints nothing and
  // only keeps the handoff current.
  assert.strictEqual(run(s, 'loop', {}).trim(), '');
  assert.match(fs.readFileSync(path.join(s.dir, '.claude', 'memory', 'handoff.json'), 'utf8'), /quarterly report/);
  s.clean();
});

test('a small session gets no cache line', () => {
  const s = session([human('x'), reply(1000, 30000)]);
  assert.doesNotMatch(run(s, 'recall', { prompt: 'next' }), /\[cache\]/);
  s.clean();
});

test('after a turn that paid to re-send cached context, the next reply says why and how to avoid it', () => {
  const request = (id, ago, effort, read, write) => ({
    type: 'assistant',
    requestId: id,
    effort,
    timestamp: new Date(Date.now() - ago).toISOString(),
    message: {
      model: 'claude-opus-5',
      content: [{ type: 'text', text: 'ok' }],
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: read,
        cache_creation_input_tokens: write,
        cache_creation: { ephemeral_1h_input_tokens: write, ephemeral_5m_input_tokens: 0 },
      },
    },
  });
  const s = session([
    human('first'), request('r1', 10 * 60000, 'high', 400000, 1000),
    human('think harder'), request('r2', 5 * 60000, 'max', 1000, 401000),
  ]);
  const out = run(s, 'recall', { prompt: 'next' });
  assert.match(out, /\[cache\] The last turn re-sent 400k already-cached tokens \(~\$4\.00\) because effort changed from high to max\. Tell the user in one line at the end of your reply, with the fix: change effort right after a \/compact\./);
  assert.doesNotMatch(run(s, 'recall', { prompt: 'again' }), /The last turn re-sent/, 'each rewrite is explained once');
  s.clean();
});

test('re-selecting the model in use asks before re-caching; a real switch is left alone', () => {
  const s = session([human('x')]);
  const switchTo = (to) => run(s, 'switch', {
    hook_event_name: 'PreModelSwitch', from_model: 'claude-opus-5', to_model: to, requested_model: 'opus',
    source: 'command', context_tokens: 347000, prompt_cache_warm: true, cache_ttl: '1h', estimated_cache_write_usd: 3.47,
  });
  const same = JSON.parse(switchTo('claude-opus-5').trim()).hookSpecificOutput;
  assert.strictEqual(same.hookEventName, 'PreModelSwitch');
  assert.strictEqual(same.permissionDecision, 'ask');
  assert.match(same.permissionDecisionReason, /Already on claude-opus-5: .*347k tokens \(~\$3\.47\)/);
  assert.strictEqual(switchTo('claude-sonnet-5').trim(), '');
  const picker = run(s, 'switch', { from_model: 'claude-opus-5', to_model: 'claude-opus-5', source: 'picker', context_tokens: 347000, prompt_cache_warm: true });
  assert.strictEqual(picker.trim(), '', 'picker and SDK switches are never asked about: a headless session would refuse');
  s.clean();
});

test('recall does not repeat a record the core block already injected', () => {
  const s = session([human('earlier')]);
  const db = path.join(s.dir, 'records.jsonl');
  const { MemoryStore } = require('../memory/store.cjs');
  const store = new MemoryStore({ path: db }).load();
  store.add({ kind: 'fact', text: 'Deploys go through the staging pipeline first', pinned: true });
  store.add({ kind: 'fact', text: 'Staging pipeline deploys need the VPN' });
  store.save();

  const out = run(s, 'recall', { prompt: 'how do staging pipeline deploys work' }, { SMART_MEMORY_PATH: db });
  assert.match(out, /\[memory\] .*Staging pipeline deploys need the VPN/);
  assert.doesNotMatch(out, /\[memory\] .*Deploys go through the staging pipeline first/);
  s.clean();
});
