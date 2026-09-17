'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// The plugin install is the two-command path most users take, so its manifest,
// hooks and CLI shim are held to the same bar as the settings installer.

const REPO = path.join(__dirname, '..', '..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(REPO, rel), 'utf8'));
const { PROFILES, HOOK_SPEC } = require('../../bin/harness.js');

test('plugin, marketplace and package agree on name, version and source', () => {
  const plugin = readJson('.claude-plugin/plugin.json');
  const market = readJson('.claude-plugin/marketplace.json');
  assert.strictEqual(plugin.name, 'rcskills');
  assert.strictEqual(plugin.version, readJson('package.json').version, 'bump both together');
  const entry = market.plugins.find((p) => p.name === plugin.name);
  assert.ok(entry, 'the marketplace lists the plugin');
  assert.strictEqual(entry.source, './');
});

test('plugin hooks are the standard profile, with timeouts in seconds', () => {
  const { hooks } = readJson('hooks/hooks.json');
  const wired = [];
  for (const [event, groups] of Object.entries(hooks)) {
    for (const g of groups) {
      for (const h of g.hooks) {
        const m = /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/\.claude\/helpers\/learning-hook\.cjs" (\w+) --global --plugin$/.exec(h.command);
        assert.ok(m, `shell-neutral plugin command: ${h.command}`);
        assert.strictEqual(HOOK_SPEC[m[1]].event, event);
        assert.strictEqual(h.timeout, HOOK_SPEC[m[1]].timeout);
        assert.ok(h.timeout <= 10, 'Claude Code reads hook timeouts as seconds');
        wired.push(m[1]);
      }
    }
  }
  assert.deepStrictEqual(wired.sort(), [...PROFILES.standard.hooks].sort());
  assert.ok(!hooks.PostToolUse, 'never a per-tool-call hook');
});

test('rcskills shim on the plugin PATH runs the CLI', () => {
  const shim = path.join(REPO, 'bin', 'rcskills');
  assert.match(fs.readFileSync(shim, 'utf8'), /^#!\/usr\/bin\/env node\n/, 'LF shebang, or env looks for "node\\r"');
  const r = spawnSync(process.execPath, [shim], { encoding: 'utf8' });
  assert.match(r.stdout, /Usage: rcskills/);
  const git = spawnSync('git', ['ls-files', '-s', 'bin/rcskills'], { cwd: REPO, encoding: 'utf8' });
  if (git.status === 0 && git.stdout) assert.match(git.stdout, /^100755 /, 'executable on macOS and Linux');
});

function hookRun(mode, home, extraArgs = ['--global', '--plugin']) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-proj-'));
  const r = spawnSync(process.execPath, [path.join(REPO, '.claude', 'helpers', 'learning-hook.cjs'), mode, ...extraArgs], {
    cwd: project,
    encoding: 'utf8',
    input: JSON.stringify({ prompt: 'hello', session_id: 'plugin-test', source: 'startup' }),
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CLAUDE_PROJECT_DIR: project,
      TOKEN_HARNESS_CONFIG: path.join(home, 'config.json'),
      SMART_MEMORY_PATH: '',
    },
  });
  const wroteIntoProject = fs.existsSync(path.join(project, '.claude'));
  fs.rmSync(project, { recursive: true, force: true });
  return { ...r, wroteIntoProject };
}

test('installed both ways, the plugin copy stands down so nothing fires twice', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-home-'));
  const seed = spawnSync(process.execPath, [path.join(REPO, 'tools', 'memory', 'cli.cjs'), 'add', 'Always run the linter first', '--pin'], {
    encoding: 'utf8',
    env: { ...process.env, SMART_MEMORY_PATH: path.join(home, 'seed.jsonl') },
  });
  assert.strictEqual(seed.status, 0, seed.stderr);

  // The pinned record lives in the project store the hook reads under --global.
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-proj-'));
  const run = (args, extraEnv = {}) => spawnSync(process.execPath, [path.join(REPO, '.claude', 'helpers', 'learning-hook.cjs'), 'core', ...args], {
    cwd: project,
    encoding: 'utf8',
    input: JSON.stringify({ session_id: 'plugin-test', source: 'startup' }),
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CLAUDE_PROJECT_DIR: project,
      TOKEN_HARNESS_CONFIG: path.join(home, 'config.json'),
      SMART_MEMORY_PATH: path.join(home, 'seed.jsonl'),
      CLAUDE_CONFIG_DIR: '',
      ...extraEnv,
    },
  });

  assert.match(run(['--global', '--plugin']).stdout, /\[core\].*linter first/, 'plugin alone speaks');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node "/x/.claude/helpers/learning-hook.cjs" core --global' }] }] },
  }));
  assert.strictEqual(run(['--global', '--plugin']).stdout, '', 'plugin stands down beside a settings install');
  assert.match(run(['--global']).stdout, /linter first/, 'the settings copy still runs');

  // Claude Code reads user settings from CLAUDE_CONFIG_DIR when it is set, so a
  // settings install there must silence the plugin too, and one left in ~/.claude must not.
  const settings = fs.readFileSync(path.join(home, '.claude', 'settings.json'));
  fs.rmSync(path.join(home, '.claude', 'settings.json'));
  const configDir = path.join(home, 'claude-config');
  fs.mkdirSync(configDir);
  fs.writeFileSync(path.join(configDir, 'settings.json'), settings);
  assert.strictEqual(run(['--global', '--plugin'], { CLAUDE_CONFIG_DIR: configDir }).stdout, '',
    'plugin stands down beside a settings install in CLAUDE_CONFIG_DIR');
  assert.match(run(['--global', '--plugin']).stdout, /linter first/, 'without it, that folder is not read');

  fs.rmSync(project, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test('a plugin install never writes memory into the project it runs in', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-home-'));
  const r = hookRun('recall', home);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.wroteIntoProject, false, 'memory is built from prompts and must not land in a repo');
  assert.ok(fs.existsSync(path.join(home, '.claude', 'token-harness', 'projects')), 'it goes under ~/.claude instead');
  fs.rmSync(home, { recursive: true, force: true });
});

test('the repo tracks no stray files from mis-quoted shell commands', () => {
  const git = spawnSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8' });
  if (git.status !== 0) return;
  // An unquoted `a => b` in a shell command creates a file named `b`. 25 of them
  // were once committed to the root.
  const stray = git.stdout.split('\n').filter(Boolean).filter((f) => /[(){}'`$!\[\],]/.test(f));
  assert.deepStrictEqual(stray, []);
  for (const f of git.stdout.split('\n').filter((l) => l && !l.includes('/'))) {
    const full = path.join(REPO, f);
    if (fs.existsSync(full)) assert.ok(fs.statSync(full).size > 0, `empty root file: ${f}`);
  }
});
