'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, 'cli.cjs');

test('backtest backfills and prints the cost of a complex task per model', () => {
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-backtest-'));
  const project = path.join(config, 'projects', 'p');
  fs.mkdirSync(project, { recursive: true });
  const human = (content) => ({ type: 'user', promptSource: 'sdk', origin: { kind: 'human' }, message: { content } });
  const usage = { input_tokens: 0, cache_read_input_tokens: 100000, cache_creation_input_tokens: 0, output_tokens: 2000 };
  const edit = (id, f) => ({
    type: 'assistant', requestId: id,
    message: { model: 'claude-opus-5-5', usage, content: [{ type: 'tool_use', name: 'Edit', input: { file_path: f } }] },
  });
  const lines = [human('rebuild the exporter'), ...Array.from({ length: 8 }, (_, i) => edit(`r${i}`, `/r/f${i}.js`))];
  fs.writeFileSync(path.join(project, 't.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  const store = path.join(config, 'costs.json');

  const r = spawnSync(process.execPath, [CLI, 'backtest'], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: config, SMART_MEMORY_PATH: path.join(config, 'records.jsonl'), TOKEN_HARNESS_MODEL_COSTS: store },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  // 8 requests x (100k x $0.20/M + 2k x $20/M) = $0.48.
  assert.match(r.stdout, /cost per complex task on your sessions \(median, list price\):\n {2}claude-opus-5-5 +\$0\.48 over 1 task\(s\) — 15 needed to count/);
  assert.ok(fs.existsSync(store), 'the record the model choice reads was written');
  fs.rmSync(config, { recursive: true, force: true });
});
