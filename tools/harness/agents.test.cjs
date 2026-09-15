'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { rate } = require('../model-router/cost.cjs');
const { AGENT_TYPE } = require('../model-router/index.cjs');

const ROOT = path.join(__dirname, '..', '..');
const HARNESS = path.join(ROOT, 'bin', 'harness.js');
const AGENTS = path.join(ROOT, 'agents');

function frontmatter(file) {
  const m = fs.readFileSync(file, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const fields = {};
  if (!m) return fields;
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) fields[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return fields;
}

test('every routed subagent exists, is named for its file, and pins a priced model', () => {
  for (const name of Object.values(AGENT_TYPE)) {
    const f = frontmatter(path.join(AGENTS, `${name}.md`));
    assert.strictEqual(f.name, name);
    assert.ok(f.description && f.description.length > 40, `${name} needs a description that can trigger`);
    assert.ok(rate(f.model), `${name} pins ${f.model}, which must be a known, priced model`);
  }
});

test('each subagent pins the model family the router routes to it', () => {
  for (const [family, name] of Object.entries(AGENT_TYPE)) {
    assert.match(frontmatter(path.join(AGENTS, `${name}.md`)).model, new RegExp(family));
  }
});

function run(dir, args) {
  return spawnSync(process.execPath, [HARNESS, ...args], { cwd: dir, encoding: 'utf8' });
}

test('install adds the subagents, never overwrites your own, and uninstall removes only its own', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-install-'));
  const agentsDir = path.join(dir, '.claude', 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, 'rc-sonnet.md'), 'my own agent\n');

  const r = run(dir, ['install', '--profile', 'minimal']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(agentsDir, 'rc-haiku.md')));
  assert.ok(fs.existsSync(path.join(agentsDir, 'rc-opus.md')));
  assert.strictEqual(fs.readFileSync(path.join(agentsDir, 'rc-sonnet.md'), 'utf8'), 'my own agent\n');
  assert.match(r.stdout, /rc-sonnet\.md/, 'the agent left alone is reported');

  run(dir, ['uninstall']);
  assert.ok(!fs.existsSync(path.join(agentsDir, 'rc-haiku.md')));
  assert.strictEqual(fs.readFileSync(path.join(agentsDir, 'rc-sonnet.md'), 'utf8'), 'my own agent\n');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('reinstalling refreshes subagents this harness installed before', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-reinstall-'));
  run(dir, ['install', '--profile', 'minimal']);
  const file = path.join(dir, '.claude', 'agents', 'rc-haiku.md');
  fs.writeFileSync(file, 'stale copy\n');
  run(dir, ['install', '--profile', 'minimal']);
  assert.notStrictEqual(fs.readFileSync(file, 'utf8'), 'stale copy\n');
  fs.rmSync(dir, { recursive: true, force: true });
});
