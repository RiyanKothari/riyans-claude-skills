'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * User-level settings shared by every project, in ~/.claude/token-harness/config.json.
 * Environment variables override the file, so a single project can opt out through
 * the `env` block of its own .claude/settings.json.
 */
const DEFAULTS = {
  compact: {
    enabled: true,
    threshold: 160000,
    remindEvery: 100000,
  },
};

function configPath() {
  return process.env.TOKEN_HARNESS_CONFIG
    || path.join(os.homedir(), '.claude', 'token-harness', 'config.json');
}

function positive(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

function readConfig(p = configPath()) {
  if (!fs.existsSync(p)) return { ok: true, value: {}, error: '' };
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')), error: '' };
  } catch (e) {
    return { ok: false, value: {}, error: String(e.message) };
  }
}

function sanitize(raw) {
  const r = raw || {};
  return {
    enabled: r.enabled !== false,
    threshold: positive(r.threshold) || DEFAULTS.compact.threshold,
    remindEvery: positive(r.remindEvery) || DEFAULTS.compact.remindEvery,
  };
}

/**
 * Effective settings: defaults, then the config file, then environment variables.
 * A broken config file falls back to defaults here; `set` refuses to overwrite it.
 */
function load(env = process.env) {
  const file = readConfig().value || {};
  const compact = sanitize({ ...DEFAULTS.compact, ...(file.compact || {}) });

  const mode = String(env.TOKEN_HARNESS_COMPACT || '').trim().toLowerCase();
  const modeTokens = positive(mode);
  if (mode === 'off' || mode === 'false' || mode === '0') compact.enabled = false;
  else if (mode === 'on' || mode === 'true') compact.enabled = true;
  else if (modeTokens) {
    compact.enabled = true;
    compact.threshold = modeTokens;
  }

  const remind = positive(env.TOKEN_HARNESS_COMPACT_REMIND);
  if (remind) compact.remindEvery = remind;

  return { compact };
}

/** Persist one setting. An unreadable config file is not an empty one, so it is never overwritten. */
function set(key, value) {
  const p = configPath();
  const read = readConfig(p);
  if (!read.ok) throw new Error(`refusing to overwrite unreadable config ${p}: ${read.error}`);

  const current = read.value || {};
  const compact = sanitize({ ...DEFAULTS.compact, ...(current.compact || {}) });
  const v = String(value ?? '').trim().toLowerCase();
  const tokens = positive(v);

  if (key === 'compact') {
    if (v === 'off') compact.enabled = false;
    else if (v === 'on') compact.enabled = true;
    else if (tokens) {
      compact.enabled = true;
      compact.threshold = tokens;
    } else {
      throw new Error(`compact expects on, off or a token count, got "${value}"`);
    }
  } else if (key === 'compact-remind') {
    if (!tokens) throw new Error(`compact-remind expects a token count, got "${value}"`);
    compact.remindEvery = tokens;
  } else {
    throw new Error(`unknown setting "${key}"`);
  }

  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify({ ...current, compact }, null, 2)}\n`, 'utf8');
  return compact;
}

function describe(settings) {
  const c = settings.compact;
  const k = (n) => `${Math.round(n / 1000)}k`;
  return [
    `compact prompts:    ${c.enabled ? 'on' : 'off'}`,
    `  first prompt at: ${k(c.threshold)} tokens of context`,
    `  then every:      ${k(c.remindEvery)} tokens of further growth`,
    `config file:        ${configPath()}`,
    'env overrides:      TOKEN_HARNESS_COMPACT=on|off|<tokens>, TOKEN_HARNESS_COMPACT_REMIND=<tokens>',
  ].join('\n');
}

if (require.main === module) {
  const [key, value] = process.argv.slice(2);
  try {
    if (key) set(key, value);
    console.log(describe(load()));
  } catch (e) {
    console.error(e.message);
    console.error('usage: rcskills config [compact <on|off|tokens>] [compact-remind <tokens>]');
    process.exitCode = 1;
  }
}

module.exports = { DEFAULTS, configPath, load, set, describe };
