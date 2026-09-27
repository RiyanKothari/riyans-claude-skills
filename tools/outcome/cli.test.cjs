'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, 'cli.cjs');

test('backtest reports how often the model advice would have put complex work on Sonnet', () => {
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-backtest-'));
  const project = path.join(config, 'projects', 'p');
  fs.mkdirSync(project, { recursive: true });
  const human = (content) => ({ type: 'user', promptSource: 'sdk', origin: { kind: 'human' }, message: { content } });
  const read = (f) => ({ type: 'assistant', message: { model: 'claude-opus-5', content: [{ type: 'tool_use', name: 'Read', input: { file_path: f } }] } });
  const lines = [];
  for (let i = 0; i < 5; i++) lines.push(human(`what does helper ${i} return?`), read(`/r/h${i}.js`));
  fs.writeFileSync(path.join(project, 't.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);

  const r = spawnSync(process.execPath, [CLI, 'backtest'], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: config, SMART_MEMORY_PATH: path.join(config, 'records.jsonl') },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /model switching, replayed over 5 turns/);
  assert.match(r.stdout, /complex work on Sonnet: 0/);
  assert.match(r.stdout, /switches: +1 down, 0 up/);
  fs.rmSync(config, { recursive: true, force: true });
});
