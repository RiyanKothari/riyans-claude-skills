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
    // 'dynamic' works the prompt point out per session; 'fixed' uses `threshold`.
    mode: 'dynamic',
    threshold: 160000,
    // Dynamic: prompt once re-reading the context costs this much per request...
    budgetUsd: 0.15,
    // ...or once it passes this share of the model's context window, whichever is first.
    qualityShare: 0.4,
    remindEvery: 100000,
  },
  cacheGuard: {
    enabled: true,
    // Act when re-caching the session would cost this much more than a fresh one.
    budgetUsd: 0.5,
    // notify: tell the user after a reply. block: also hold the first message after expiry.
    mode: 'notify',
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

function positiveFloat(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
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
  const share = positiveFloat(r.qualityShare);
  return {
    enabled: r.enabled !== false,
    mode: r.mode === 'fixed' ? 'fixed' : 'dynamic',
    threshold: positive(r.threshold) || DEFAULTS.compact.threshold,
    budgetUsd: positiveFloat(r.budgetUsd) || DEFAULTS.compact.budgetUsd,
    qualityShare: share && share <= 1 ? share : DEFAULTS.compact.qualityShare,
    remindEvery: positive(r.remindEvery) || DEFAULTS.compact.remindEvery,
  };
}

/** on | off | dynamic | <tokens>. Returns false when the value is not one of those. */
function applyMode(compact, value) {
  const v = String(value ?? '').trim().toLowerCase();
  const tokens = positive(v);
  if (v === 'off' || v === 'false' || v === '0') compact.enabled = false;
  else if (v === 'on' || v === 'true') compact.enabled = true;
  else if (v === 'dynamic' || v === 'auto') {
    compact.enabled = true;
    compact.mode = 'dynamic';
  } else if (tokens) {
    compact.enabled = true;
    compact.mode = 'fixed';
    compact.threshold = tokens;
  } else {
    return false;
  }
  return true;
}

/**
 * Effective settings: defaults, then the config file, then environment variables.
 * A broken config file falls back to defaults here; `set` refuses to overwrite it.
 */
function load(env = process.env) {
  const file = readConfig().value || {};
  const compact = sanitize({ ...DEFAULTS.compact, ...(file.compact || {}) });

  const mode = String(env.TOKEN_HARNESS_COMPACT || '').trim();
  if (mode) applyMode(compact, mode);

  const budget = positiveFloat(env.TOKEN_HARNESS_COMPACT_BUDGET);
  if (budget) compact.budgetUsd = budget;

  const remind = positive(env.TOKEN_HARNESS_COMPACT_REMIND);
  if (remind) compact.remindEvery = remind;

  const cacheGuard = sanitizeGuard({ ...DEFAULTS.cacheGuard, ...(file.cacheGuard || {}) });
  const guard = String(env.TOKEN_HARNESS_CACHE_GUARD || '').trim();
  if (guard) applyGuard(cacheGuard, guard);

  return { compact, cacheGuard };
}

function sanitizeGuard(raw) {
  const r = raw || {};
  return {
    enabled: r.enabled !== false,
    budgetUsd: positiveFloat(r.budgetUsd) || DEFAULTS.cacheGuard.budgetUsd,
    mode: r.mode === 'block' ? 'block' : 'notify',
  };
}

/** on | off | notify | block | <usd>. Returns false when the value is not one of those. */
function applyGuard(guard, value) {
  const v = String(value ?? '').trim().toLowerCase().replace(/^\$/, '');
  const usd = positiveFloat(v);
  if (v === 'notify' || v === 'block') {
    guard.enabled = true;
    guard.mode = v;
    return true;
  }
  if (v === 'off' || v === 'false' || v === '0') guard.enabled = false;
  else if (v === 'on' || v === 'true') guard.enabled = true;
  else if (usd) {
    guard.enabled = true;
    guard.budgetUsd = usd;
  } else {
    return false;
  }
  return true;
}

/** Persist one setting. An unreadable config file is not an empty one, so it is never overwritten. */
function set(key, value) {
  const p = configPath();
  const read = readConfig(p);
  if (!read.ok) throw new Error(`refusing to overwrite unreadable config ${p}: ${read.error}`);

  const current = read.value || {};
  const compact = sanitize({ ...DEFAULTS.compact, ...(current.compact || {}) });

  if (key === 'cache-guard') {
    const cacheGuard = sanitizeGuard({ ...DEFAULTS.cacheGuard, ...(current.cacheGuard || {}) });
    if (!applyGuard(cacheGuard, value)) {
      throw new Error(`cache-guard expects on, off, notify, block or a dollar amount, got "${value}"`);
    }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `${JSON.stringify({ ...current, cacheGuard }, null, 2)}\n`, 'utf8');
    return cacheGuard;
  }

  if (key === 'compact') {
    if (!applyMode(compact, value)) {
      throw new Error(`compact expects on, off, dynamic or a token count, got "${value}"`);
    }
  } else if (key === 'compact-budget') {
    const usd = positiveFloat(String(value ?? '').trim().replace(/^\$/, ''));
    if (!usd) throw new Error(`compact-budget expects a dollar amount, got "${value}"`);
    compact.budgetUsd = usd;
  } else if (key === 'compact-remind') {
    const tokens = positive(value);
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
  const lines = [`compact prompts:    ${c.enabled ? 'on' : 'off'} (${c.mode})`];
  if (c.mode === 'fixed') {
    lines.push(`  first prompt at: ${k(c.threshold)} tokens of context`);
  } else {
    lines.push(`  prompt when:      re-reading context costs $${c.budgetUsd}/request, or it passes`);
    lines.push(`                    ${Math.round(c.qualityShare * 100)}% of the model's window; sooner at a natural break, later mid-task`);
  }
  lines.push(`  then every:       ${k(c.remindEvery)} tokens of further growth`);
  const g = settings.cacheGuard || DEFAULTS.cacheGuard;
  lines.push(`cache guard:        ${g.enabled ? 'on' : 'off'} (${g.mode})`);
  lines.push(`  acts when:        re-caching the session would cost $${g.budgetUsd}+ more than a fresh one`);
  lines.push(`  then:             ${g.mode === 'block'
    ? 'holds the first message after the cache expires, once'
    : 'tells you after a reply until when the cache is cheap; never holds a message'}`);
  lines.push(`config file:        ${configPath()}`);
  lines.push('env overrides:      TOKEN_HARNESS_COMPACT=on|off|dynamic|<tokens>, '
    + 'TOKEN_HARNESS_COMPACT_BUDGET=<usd>, TOKEN_HARNESS_COMPACT_REMIND=<tokens>, '
    + 'TOKEN_HARNESS_CACHE_GUARD=on|off|notify|block|<usd>');
  return lines.join('\n');
}

if (require.main === module) {
  const [key, value] = process.argv.slice(2);
  try {
    if (key) set(key, value);
    console.log(describe(load()));
  } catch (e) {
    console.error(e.message);
    console.error('usage: rcskills config [compact <on|off|dynamic|tokens>] [compact-budget <usd>] [compact-remind <tokens>] [cache-guard <on|off|notify|block|usd>]');
    process.exitCode = 1;
  }
}

module.exports = { DEFAULTS, configPath, load, set, describe };
