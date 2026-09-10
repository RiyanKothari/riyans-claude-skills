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
  standard: { hooks: ['core', 'recall'], desc: 'fixed core at session start + per-prompt recall' },
  strict: { hooks: ['core', 'recall', 'finalize'], desc: 'standard + outcome capture (the learning loop)' },
};

const HOOK_SPEC = {
  core: { event: 'SessionStart', timeout: 6000 },
  recall: { event: 'UserPromptSubmit', timeout: 8000 },
  finalize: { event: 'Stop', timeout: 6000 },
};

function claudeDir(global) {
  return global
    ? path.join(os.homedir(), '.claude')
    : path.join(process.cwd(), '.claude');
}

function statePath(dir) {
  return path.join(dir, 'harness-state.json');
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

function hookCommand(mode) {
  const script = path.join(REPO, '.claude', 'helpers', 'learning-hook.cjs');
  // Quoted for paths with spaces; degrades to a no-op if the file is gone, so a
  // half-removed install can never break prompt submission.
  return process.platform === 'win32'
    ? `cmd /c "IF EXIST "${script}" (node "${script}" ${mode}) ELSE (exit 0)"`
    : `[ -f '${script}' ] && node '${script}' ${mode} || true`;
}

function backupSettings(settingsFile) {
  if (!fs.existsSync(settingsFile)) return null;
  const bak = `${settingsFile}.bak-${Date.now()}`;
  fs.copyFileSync(settingsFile, bak);
  return bak;
}

/** Merge without clobbering: the user's existing hooks are left untouched. */
function addHooks(settings, modes) {
  settings.hooks = settings.hooks || {};
  const added = [];

  for (const mode of modes) {
    const spec = HOOK_SPEC[mode];
    if (!spec) continue;
    const cmd = hookCommand(mode);
    settings.hooks[spec.event] = settings.hooks[spec.event] || [];

    // Match on our own tag, not on the command string: JSON escaping makes
    // substring checks against quoted paths silently fail, which would let a
    // repeat install stack duplicate hooks.
    const already = settings.hooks[spec.event].some((g) => g && g[MARKER] === mode);
    if (already) continue;

    settings.hooks[spec.event].push({
      [MARKER]: mode,
      hooks: [{ type: 'command', command: cmd, timeout: spec.timeout }],
    });
    added.push(`${spec.event}:${mode}`);
  }
  return added;
}

function removeHooks(settings) {
  if (!settings.hooks) return 0;
  let removed = 0;
  for (const event of Object.keys(settings.hooks)) {
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
  const added = addHooks(settings, profile.hooks);
  writeJson(settingsFile, settings);

  writeJson(statePath(dir), {
    version: readJson(path.join(REPO, 'package.json'), {}).version || '0.0.0',
    profile: opts.profile,
    installedAt: new Date().toISOString(),
    repo: REPO,
    skills: installed,
    hooks: added,
    settingsBackup: backup,
  });

  console.log(`installed riyans-claude-skills (${opts.profile}) -> ${dir}`);
  console.log(`  skills: ${installed.join(', ')}`);
  const hookNote = added.length
    ? added.join(', ')
    : (profile.hooks.length ? 'already wired (no change)' : 'none (minimal profile)');
  console.log(`  hooks: ${hookNote}`);
  if (backup) console.log(`  settings backed up: ${path.basename(backup)}`);
  console.log('\nrun `node bin/harness.js doctor` to verify');
}

function doctor(opts) {
  const dir = claudeDir(opts.global);
  const state = readJson(statePath(dir), null);
  const checks = [];

  const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });

  check('state file', state, statePath(dir));
  check(
    'skill installed',
    fs.existsSync(path.join(dir, 'skills', 'token-harness', 'SKILL.md')),
    path.join(dir, 'skills', 'token-harness'),
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

  let bad = 0;
  for (const c of checks) {
    if (!c.ok) bad++;
    console.log(`${c.ok ? 'ok  ' : 'FAIL'}  ${c.name.padEnd(20)} ${c.detail}`);
  }

  console.log(bad ? `\n${bad} check(s) failed â€” run install again to repair` : '\nall checks passed');
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
    console.error(`refusing to uninstall: ${settingsFile} is not valid JSON â€” remove the hooks by hand`);
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

function usage() {
  console.log('Usage: harness.js <install|doctor|status|uninstall> [--profile P] [--global]');
  console.log('\nProfiles:');
  for (const [k, v] of Object.entries(PROFILES)) {
    console.log(`  ${k.padEnd(9)} ${v.desc}`);
  }
  console.log('\n--global installs to ~/.claude instead of ./.claude');
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
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
  PROFILES, HOOK_SPEC, addHooks, removeHooks, hookCommand, readSettings, MARKER,
};
