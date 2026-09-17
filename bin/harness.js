#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const MARKER = 'riyans-claude-skills';

/**
 * Profiles trade automation against per-turn overhead. Each hook is a node
 * process (~166ms), so the honest default installs only the two that pay for
 * themselves.
 */
const PROFILES = {
  minimal: { hooks: [], desc: 'skill only, no hooks, zero per-turn overhead' },
  standard: { hooks: ['core', 'recall', 'loop', 'switch'], desc: 'fixed core at session start + per-prompt recall + ralph loop + cache notices' },
  // Outcome capture rides the Stop hook that already runs, instead of a second
  // process at every stop (650ms measured per spawn).
  strict: { hooks: ['core', 'recall', 'loop', 'switch'], learn: true, desc: 'standard + outcome capture in the same Stop hook (the learning loop)' },
};

// Timeouts are seconds: Claude Code multiplies them by 1000. Versions before 1.1.0
// wrote 6000, which let a hung hook hold a session for 100 minutes.
const HOOK_SPEC = {
  core: { event: 'SessionStart', timeout: 6 },
  recall: { event: 'UserPromptSubmit', timeout: 8 },
  loop: { event: 'Stop', timeout: 6 },
  // Fires only when the model changes, so it adds nothing per turn.
  switch: { event: 'PreModelSwitch', timeout: 6 },
};

// Claude Code reads user settings from CLAUDE_CONFIG_DIR when it is set, so a
// global install written to ~/.claude there would never load.
function claudeDir(global) {
  return global
    ? process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
    : path.join(process.cwd(), '.claude');
}

function statePath(dir) {
  return path.join(dir, 'harness-state.json');
}

/**
 * The plugin install, which keeps no state file of ours: Claude Code copies the
 * repo into its own cache and wires hooks/hooks.json itself. Running from that
 * copy is the certain signal; otherwise look for it under the config directory.
 * Without this, `rcskills doctor` reports a healthy plugin install as three
 * failures, because every check it knows about belongs to the settings install.
 */
function pluginInstall() {
  if (fs.existsSync(path.join(REPO, 'hooks', 'hooks.json')) && /[\\/]plugins[\\/]/.test(REPO)) return REPO;
  const root = path.join(claudeDir(true), 'plugins');
  const found = [];
  const walk = (d, depth) => {
    if (found.length || depth > 5) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.name === '.claude-plugin') && fs.existsSync(path.join(d, 'hooks', 'hooks.json'))) {
      const manifest = readJson(path.join(d, '.claude-plugin', 'plugin.json'), {});
      if (manifest.name === 'rcskills') {
        found.push(d);
        return;
      }
    }
    for (const e of entries) if (e.isDirectory()) walk(path.join(d, e.name), depth + 1);
  };
  walk(root, 0);
  return found[0] || null;
}

function readJson(p, fallback) {
  try {
    // A UTF-8 BOM makes JSON.parse throw. Silently falling back would treat a
    // perfectly good config as empty.
    return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
  } catch {
    return fallback;
  }
}

/**
 * Distinguishes "no file" from "file I cannot read".
 *
 * Treating an unreadable settings.json as `{}` and writing over it destroys the
 * user's entire configuration. Absent is safe to default; unparseable is not.
 */
function readSettings(p) {
  if (!fs.existsSync(p)) return { ok: true, value: {}, existed: false };
  const raw = fs.readFileSync(p, 'utf8').replace(/^﻿/, '');
  if (!raw.trim()) return { ok: true, value: {}, existed: true };
  try {
    return { ok: true, value: JSON.parse(raw), existed: true };
  } catch (e) {
    return { ok: false, error: e.message, existed: true };
  }
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// Shell-neutral on purpose: Claude Code runs Windows hooks through Git Bash, where
// MSYS rewrites `cmd /c` to `cmd C:/` — cmd then runs interactively, exits 0, and
// every hook reports success without executing.
function hookCommand(mode, opts = {}) {
  const script = path.join(REPO, '.claude', 'helpers', 'learning-hook.cjs').replace(/\\/g, '/');
  // --global lets the hook stand down inside this repo, whose project settings
  // already run it, instead of firing twice per event.
  const learn = opts.learn && mode === 'loop' ? ' --learn' : '';
  return `node "${script}" ${mode}${opts.global ? ' --global' : ''}${learn}`;
}

function backupSettings(settingsFile) {
  if (!fs.existsSync(settingsFile)) return null;
  const bak = `${settingsFile}.bak-${Date.now()}`;
  fs.copyFileSync(settingsFile, bak);
  return bak;
}

/** Merge without clobbering: the user's existing hooks are left untouched. */
function addHooks(settings, modes, opts = {}) {
  settings.hooks = settings.hooks || {};
  const added = [];

  // Our groups for modes this profile no longer runs (a 1.0 strict install's separate
  // finalize hook, or strict -> standard) are removed, or they would keep spawning.
  for (const event of Object.keys(settings.hooks)) {
    const groups = settings.hooks[event];
    if (!Array.isArray(groups)) continue;
    settings.hooks[event] = groups.filter((g) => !g || !g[MARKER] || modes.includes(g[MARKER]));
    if (!settings.hooks[event].length) delete settings.hooks[event];
  }

  for (const mode of modes) {
    const spec = HOOK_SPEC[mode];
    if (!spec) continue;
    const cmd = hookCommand(mode, opts);
    settings.hooks[spec.event] = settings.hooks[spec.event] || [];

    // Match on our own tag, not on the command string: JSON escaping makes
    // substring checks against quoted paths silently fail, which would let a
    // repeat install stack duplicate hooks.
    const hook = { type: 'command', command: cmd, timeout: spec.timeout };
    const mine = settings.hooks[spec.event].find((g) => g && g[MARKER] === mode);
    if (mine) {
      // A re-install repairs what an older version wrote, such as a timeout in ms.
      mine.hooks = [hook];
      continue;
    }

    settings.hooks[spec.event].push({
      [MARKER]: mode,
      hooks: [hook],
    });
    added.push(`${spec.event}:${mode}`);
  }
  return added;
}

function removeHooks(settings) {
  if (!settings.hooks) return 0;
  let removed = 0;
  for (const event of Object.keys(settings.hooks)) {
    // A hand-edited settings.json can hold anything; uninstall must not throw on it.
    if (!Array.isArray(settings.hooks[event])) continue;
    const before = settings.hooks[event].length;
    settings.hooks[event] = settings.hooks[event].filter((g) => !g || !g[MARKER]);
    removed += before - settings.hooks[event].length;
    if (!settings.hooks[event].length) delete settings.hooks[event];
  }
  return removed;
}

function install(opts) {
  const dir = claudeDir(opts.global);
  const profile = PROFILES[opts.profile] || PROFILES.standard;
  // Every skill in skills/ ships, so adding one is a matter of creating a
  // directory rather than editing the installer.
  const srcSkills = path.join(REPO, 'skills');
  const installed = [];
  for (const e of fs.readdirSync(srcSkills, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    if (!fs.existsSync(path.join(srcSkills, e.name, 'SKILL.md'))) continue;
    const dest = path.join(dir, 'skills', e.name);
    copyDir(path.join(srcSkills, e.name), dest);
    installed.push(e.name);
  }

  // Model-pinned subagents the router names. A same-named agent this harness did
  // not install before is the user's own, and is never overwritten.
  const previous = readJson(statePath(dir), null);
  const ownedBefore = new Set((previous && previous.agents) || []);
  const agents = [];
  const skippedAgents = [];
  const srcAgents = path.join(REPO, 'agents');
  if (fs.existsSync(srcAgents)) {
    for (const f of fs.readdirSync(srcAgents)) {
      if (!f.endsWith('.md')) continue;
      const destAgent = path.join(dir, 'agents', f);
      if (fs.existsSync(destAgent) && !ownedBefore.has(f)) {
        skippedAgents.push(f);
        continue;
      }
      fs.mkdirSync(path.dirname(destAgent), { recursive: true });
      fs.copyFileSync(path.join(srcAgents, f), destAgent);
      agents.push(f);
    }
  }

  const settingsFile = path.join(dir, 'settings.json');
  const read = readSettings(settingsFile);
  if (!read.ok) {
    console.error(`refusing to install: ${settingsFile} exists but is not valid JSON`);
    console.error(`  ${read.error}`);
    console.error('Fix or move that file first - overwriting it would destroy your config.');
    process.exitCode = 1;
    return;
  }

  const settings = read.value;
  const backup = backupSettings(settingsFile);
  const added = addHooks(settings, profile.hooks, { global: opts.global, learn: profile.learn });
  writeJson(settingsFile, settings);

  writeJson(statePath(dir), {
    version: readJson(path.join(REPO, 'package.json'), {}).version || '0.0.0',
    profile: opts.profile,
    installedAt: new Date().toISOString(),
    repo: REPO,
    skills: installed,
    agents,
    hooks: added,
    settingsBackup: backup,
  });

  console.log(`installed riyans-claude-skills (${opts.profile}) -> ${dir}`);
  console.log(`  skills: ${installed.join(', ')}`);
  console.log(`  agents: ${agents.join(', ') || 'none'}`);
  if (skippedAgents.length) {
    console.log(`  agents left alone (you already have your own): ${skippedAgents.join(', ')}`);
  }
  const hookNote = added.length
    ? added.join(', ')
    : (profile.hooks.length ? 'already wired (commands and timeouts refreshed)' : 'none (minimal profile)');
  console.log(`  hooks: ${hookNote}`);
  if (backup) console.log(`  settings backed up: ${path.basename(backup)}`);
  console.log('\nrun `node bin/harness.js doctor` to verify');
}

function doctor(opts) {
  const dir = claudeDir(opts.global);
  const state = readJson(statePath(dir), null);
  const checks = [];

  const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });

  const plugin = pluginInstall();
  if (plugin && !state) {
    check('plugin install', true, plugin);
    check('hooks wired', fs.existsSync(path.join(plugin, 'hooks', 'hooks.json')), 'hooks/hooks.json');
    check(
      'skill installed',
      fs.existsSync(path.join(plugin, 'skills', 'token-harness', 'SKILL.md')),
      path.join(plugin, 'skills'),
    );
    check('subagents installed', fs.existsSync(path.join(plugin, 'agents', 'rc-haiku.md')), 'rcskills:rc-* agents');
    check('hook script present', fs.existsSync(path.join(plugin, '.claude', 'helpers', 'learning-hook.cjs')), 'learning-hook.cjs');
    check('node >= 18', Number(process.versions.node.split('.')[0]) >= 18, process.version);
    return report(checks, 'the plugin manages this install; `rcskills install` is not needed');
  }

  check('state file', state, statePath(dir));
  check(
    'skill installed',
    fs.existsSync(path.join(dir, 'skills', 'token-harness', 'SKILL.md')),
    path.join(dir, 'skills', 'token-harness'),
  );
  const agentSrc = path.join(REPO, 'agents');
  const agentFiles = fs.existsSync(agentSrc) ? fs.readdirSync(agentSrc).filter((f) => f.endsWith('.md')) : [];
  const missingAgents = agentFiles.filter((f) => !fs.existsSync(path.join(dir, 'agents', f)));
  check(
    'subagents installed',
    !missingAgents.length,
    missingAgents.length ? `missing: ${missingAgents.join(', ')}` : `${agentFiles.length} model-pinned`,
  );
  check(
    'hook script present',
    fs.existsSync(path.join(REPO, '.claude', 'helpers', 'learning-hook.cjs')),
    'learning-hook.cjs',
  );

  const settings = readJson(path.join(dir, 'settings.json'), {});
  const wired = JSON.stringify(settings.hooks || {}).split(MARKER).length - 1;
  const expected = state ? (PROFILES[state.profile] || PROFILES.standard).hooks.length : 0;
  check('hooks wired', wired >= expected, `${wired} found, ${expected} expected`);
  check('node >= 18', Number(process.versions.node.split('.')[0]) >= 18, process.version);

  // Installed both ways on purpose or by accident, the plugin copy stands down,
  // so say which one is actually speaking.
  return report(checks, plugin ? `also installed as a plugin (${plugin}); its hooks stand down so nothing is doubled` : null);
}

function report(checks, note) {
  let bad = 0;
  for (const c of checks) {
    if (!c.ok) bad++;
    console.log(`${c.ok ? 'ok  ' : 'FAIL'}  ${c.name.padEnd(20)} ${c.detail}`);
  }

  console.log(bad ? `\n${bad} check(s) failed — run install again to repair` : '\nall checks passed');
  if (note) console.log(note);
  process.exitCode = bad ? 1 : 0;
}

function uninstall(opts) {
  const dir = claudeDir(opts.global);
  const state = readJson(statePath(dir), null);
  if (!state) {
    console.log('no install found here');
    return;
  }

  const settingsFile = path.join(dir, 'settings.json');
  const read = readSettings(settingsFile);
  if (!read.ok) {
    console.error(`refusing to uninstall: ${settingsFile} is not valid JSON — remove the hooks by hand`);
    process.exitCode = 1;
    return;
  }

  const settings = read.value;
  backupSettings(settingsFile);
  const removed = removeHooks(settings);
  writeJson(settingsFile, settings);

  // Only skills this harness installed are removed, and only the ones the
  // state file recorded. Memory and scorecards are the user's data and are
  // never deleted by an uninstall.
  for (const name of state.skills || []) {
    const skillDir = path.join(dir, 'skills', path.basename(name));
    if (fs.existsSync(skillDir)) fs.rmSync(skillDir, { recursive: true, force: true });
  }
  for (const name of state.agents || []) {
    const agentFile = path.join(dir, 'agents', path.basename(name));
    if (fs.existsSync(agentFile)) fs.rmSync(agentFile, { force: true });
  }
  fs.rmSync(statePath(dir), { force: true });

  console.log(`uninstalled: ${removed} hook group(s) removed, skill deleted`);
  console.log('memory and scorecards left intact (your data, not the harness\'s)');
}

function status(opts) {
  const dir = claudeDir(opts.global);
  const state = readJson(statePath(dir), null);
  if (!state) {
    console.log(`not installed at ${dir}`);
    return;
  }
  console.log(JSON.stringify(state, null, 2));
}

// Every tool's CLI, reachable from any project as `rcskills <tool> ...`.
const TOOLS = {
  route: 'tools/model-router/index.cjs',
  mem: 'tools/memory/cli.cjs',
  scorecard: 'tools/scorecard/cli.cjs',
  audit: 'tools/context-audit/cli.cjs',
  backtest: 'tools/outcome/cli.cjs',
  seed: 'tools/outcome/cli.cjs',
  lint: 'tools/skill-lint/cli.cjs',
  config: 'tools/config.cjs',
  loop: 'tools/loop.cjs',
  spend: 'tools/outcome/spend.cjs',
};

function runTool(name, rest) {
  // The outcome CLI takes its own subcommand, so the name is passed through.
  const args = name === 'backtest' || name === 'seed' ? [name, ...rest] : rest;
  const r = require('child_process').spawnSync(
    process.execPath,
    [path.join(REPO, TOOLS[name]), ...args],
    { stdio: 'inherit' },
  );
  process.exitCode = r.status ?? 1;
}

function usage() {
  console.log('Usage: rcskills <install|doctor|status|uninstall> [--profile P] [--global]');
  console.log('       rcskills <route|mem|scorecard|audit|backtest|seed|lint|config|loop|spend> [args]');
  console.log('\nProfiles:');
  for (const [k, v] of Object.entries(PROFILES)) {
    console.log(`  ${k.padEnd(9)} ${v.desc}`);
  }
  console.log('\n--global installs to ~/.claude (or CLAUDE_CONFIG_DIR) instead of ./.claude');
  console.log('--version prints the installed version');
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
    return console.log(readJson(path.join(REPO, 'package.json'), {}).version || 'unknown');
  }
  if (TOOLS[cmd]) return runTool(cmd, argv.slice(1));
  const pi = argv.indexOf('--profile');
  const opts = {
    profile: pi === -1 ? 'standard' : argv[pi + 1],
    global: argv.includes('--global'),
  };

  if (!PROFILES[opts.profile]) {
    console.log(`unknown profile: ${opts.profile}`);
    return usage();
  }

  if (cmd === 'install') return install(opts);
  if (cmd === 'doctor') return doctor(opts);
  if (cmd === 'status') return status(opts);
  if (cmd === 'uninstall') return uninstall(opts);
  return usage();
}

main();

module.exports = {
  PROFILES, HOOK_SPEC, addHooks, removeHooks, hookCommand, readSettings, claudeDir, pluginInstall, MARKER,
};
