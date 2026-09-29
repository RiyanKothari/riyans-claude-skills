'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { compare, runOnce, parseResult, parseArgs, format, MAX_BUDGET } = require('./compare.cjs');
const observed = require('./observed.cjs');

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compare-'));
  return { dir, store: path.join(dir, 'costs.json') };
}

test('the result line is found among whatever else Claude Code prints', () => {
  const out = 'warming up\n{"type":"system"}\n{"type":"result","total_cost_usd":0.42,"num_turns":7,"duration_ms":9000,"is_error":false}\n';
  assert.deepStrictEqual(parseResult(out), { type: 'result', total_cost_usd: 0.42, num_turns: 7, duration_ms: 9000, is_error: false });
  assert.strictEqual(parseResult('no json here'), null);
});

test('every task runs on every model, and only complete pairs are recorded as paired', () => {
  const t = tmpStore();
  const seen = [];
  const run = (a) => {
    seen.push([a.task, a.model, a.budget]);
    if (a.task === 'breaks' && a.model === 'claude-opus-5-5') return { model: a.model, ok: false, error: 'budget exceeded' };
    return { model: a.model, ok: true, usd: a.model === 'claude-sonnet-5-5' ? 0.3 : 0.5, turns: 10, ms: 1000, error: null };
  };
  const out = compare({ tasks: ['add validation', 'breaks'], budget: 99, store: t.store, run });
  assert.strictEqual(out.budget, MAX_BUDGET, 'the per-run cap is itself capped');
  assert.deepStrictEqual(seen.map(([task, model]) => `${task}/${model}`), [
    'add validation/claude-sonnet-5-5', 'add validation/claude-opus-5-5', 'breaks/claude-sonnet-5-5', 'breaks/claude-opus-5-5',
  ]);
  const sum = observed.summarize(observed.load(t.store));
  assert.deepStrictEqual(sum['claude-sonnet-5-5'].paired, { tasks: 1, usdPerTask: 0.3 });
  assert.deepStrictEqual(sum['claude-opus-5-5'].paired, { tasks: 1, usdPerTask: 0.5 });
  assert.match(format(out), /\[not recorded\] breaks[\s\S]*failed: budget exceeded/);
  fs.rmSync(t.dir, { recursive: true, force: true });
});

test('arguments: repeated tasks, a model list, a budget and an effort', () => {
  assert.deepStrictEqual(parseArgs(['--task', 'a', '--task', 'b', '--models', 'x, y', '--budget', '2', '--effort', 'medium']), {
    tasks: ['a', 'b'], models: ['x', 'y'], budget: 2, effort: 'medium',
  });
});

test('a real run works in a throwaway clone with capped, edit-only permissions', { skip: process.platform === 'win32' && 'needs an executable script as claude' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compare-run-'));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  const git = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
  git('init', '-q');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'x');
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  const argsFile = path.join(dir, 'args.json');
  const fake = path.join(dir, 'claude');
  fs.writeFileSync(fake, `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), cloned: require('fs').existsSync('a.txt') }));\nconsole.log(JSON.stringify({ type: 'result', total_cost_usd: 0.25, num_turns: 4, duration_ms: 2000, is_error: false }));\n`);
  fs.chmodSync(fake, 0o755);

  const r = runOnce({ claude: fake, repo, task: 'do it', model: 'claude-sonnet-5-5', budget: 1, effort: 'medium' });
  assert.deepStrictEqual([r.ok, r.usd, r.turns], [true, 0.25, 4]);
  const seen = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
  assert.ok(seen.cloned, 'ran inside a clone of the repo');
  assert.notStrictEqual(path.resolve(seen.cwd), path.resolve(repo), 'never in the user tree');
  assert.ok(!fs.existsSync(seen.cwd), 'the clone is removed afterwards');
  const a = seen.args;
  for (const [flag, value] of [['--model', 'claude-sonnet-5-5'], ['--max-budget-usd', '1'], ['--permission-mode', 'acceptEdits'], ['--effort', 'medium'], ['--output-format', 'json']]) {
    assert.strictEqual(a[a.indexOf(flag) + 1], value, flag);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
