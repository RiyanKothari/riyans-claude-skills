#!/usr/bin/env node
'use strict';

/**
 * rcskills compare — run the same tasks on two models and record what each cost.
 *
 * Everything else the model choice knows is either a benchmark at someone else's
 * settings or the user's own sessions, where two models never did the same task. A
 * paired run removes both doubts: same task, same repo, the user's own Claude Code
 * and effort. Each run works in a throwaway clone of the repo (committed work only;
 * the user's tree is never touched), may edit files but not run commands
 * (--permission-mode acceptEdits), and is capped by --max-budget-usd, which Claude
 * Code enforces. A pair is recorded only when both runs finished.
 *
 *   rcskills compare --task "add input validation to parseArgs" --task "..." \
 *     [--models claude-sonnet-5-5,claude-opus-5-5] [--budget 1] [--effort medium]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const observed = require('./observed.cjs');

const DEFAULT_MODELS = ['claude-sonnet-5-5', 'claude-opus-5-5'];
const DEFAULT_BUDGET = 1;
const MAX_BUDGET = 10;
const RUN_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * The JSON result Claude Code prints with --output-format json.
 * @param {string} stdout
 */
function parseResult(stdout) {
  const lines = String(stdout || '').trim().split('\n').reverse();
  for (const line of lines) {
    try {
      const o = JSON.parse(line);
      if (o && o.type === 'result') return o;
    } catch {
      // not the result line
    }
  }
  return null;
}

/**
 * One task on one model, in a fresh clone that is removed afterwards.
 * @param {{claude: string|string[], repo: string, task: string, model: string, budget: number, effort?: string|null}} a
 */
function runOnce(a) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcskills-compare-'));
  try {
    const clone = spawnSync('git', ['clone', '-q', '--no-hardlinks', a.repo, dir], { encoding: 'utf8' });
    if (clone.status !== 0) return { model: a.model, ok: false, error: `git clone failed: ${clone.stderr.trim()}` };
    const args = ['-p', a.task, '--model', a.model, '--output-format', 'json', '--max-budget-usd', String(a.budget),
      '--permission-mode', 'acceptEdits', '--no-session-persistence'];
    if (a.effort) args.push('--effort', a.effort);
    // claude is a path, or a command and its leading arguments ([node, script]).
    const [cmd, ...pre] = Array.isArray(a.claude) ? a.claude : [a.claude];
    const r = spawnSync(cmd, [...pre, ...args], { cwd: dir, encoding: 'utf8', timeout: RUN_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
    const res = parseResult(r.stdout);
    if (!res) return { model: a.model, ok: false, error: `no result (exit ${r.status}): ${String(r.stderr || '').trim().slice(0, 200)}` };
    const usd = Number(res.total_cost_usd);
    return {
      model: a.model,
      ok: !res.is_error && Number.isFinite(usd) && usd > 0,
      usd,
      turns: Number(res.num_turns) || 0,
      ms: Number(res.duration_ms) || 0,
      error: res.is_error ? String(res.subtype || res.result || 'error').slice(0, 200) : null,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Every task on every model; pairs where all runs finished are recorded.
 * @param {{tasks: string[], models?: string[], budget?: number, effort?: string|null, repo?: string, claude?: string|string[],
 *   store?: string, run?: typeof runOnce, log?: (s: string) => void}} o
 */
function compare(o) {
  const models = o.models && o.models.length ? o.models : DEFAULT_MODELS;
  const budget = Math.min(Number(o.budget) || DEFAULT_BUDGET, MAX_BUDGET);
  const run = o.run || runOnce;
  const log = o.log || (() => {});
  const results = [];
  for (const task of o.tasks) {
    const runs = models.map((model) => {
      log(`  ${model}: ${task.slice(0, 60)}…`);
      return run({ claude: o.claude || 'claude', repo: o.repo || process.cwd(), task, model, budget, effort: o.effort || null });
    });
    const complete = runs.every((r) => r.ok);
    results.push({ task, runs, complete });
    if (complete) {
      const id = `pair:${crypto.createHash('sha1').update(`${task}\n${Date.now()}`).digest('hex').slice(0, 12)}`;
      observed.record(runs.map((r) => ({ id, model: r.model, usd: Number(r.usd), requests: r.turns, tier: 'complex', paired: true })), o.store);
    }
  }
  return { results, models, budget };
}

function format(out) {
  const lines = [`paired runs (cap $${out.budget} each):`];
  for (const r of out.results) {
    lines.push(`  ${r.complete ? '' : '[not recorded] '}${r.task.slice(0, 70)}`);
    for (const x of r.runs) {
      lines.push(`    ${x.model.padEnd(20)} ${x.ok ? `$${x.usd.toFixed(2)}, ${x.turns} turns, ${Math.round(x.ms / 1000)}s` : `failed: ${x.error}`}`);
    }
  }
  return lines.join('\n');
}

function parseArgs(argv) {
  const o = { tasks: /** @type {string[]} */ ([]), models: /** @type {string[]} */ ([]), budget: DEFAULT_BUDGET, effort: null };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i + 1];
    if (argv[i] === '--task' && v) { o.tasks.push(v); i++; }
    else if (argv[i] === '--models' && v) { o.models = v.split(',').map((s) => s.trim()).filter(Boolean); i++; }
    else if (argv[i] === '--budget' && v) { o.budget = Number(v); i++; }
    else if (argv[i] === '--effort' && v) { o.effort = v; i++; }
  }
  return o;
}

if (require.main === module) {
  const o = parseArgs(process.argv.slice(2));
  if (!o.tasks.length || !(o.budget > 0)) {
    console.log('usage: rcskills compare --task "<task>" [--task ...] [--models a,b] [--budget usd-per-run, max 10] [--effort level]');
    process.exit(1);
  }
  const n = o.tasks.length * (o.models.length || 2);
  console.log(`running ${n} capped runs, at most $${(n * Math.min(o.budget, MAX_BUDGET)).toFixed(2)} in total`);
  const out = compare({ ...o, claude: process.env.CLAUDE_BIN || 'claude', log: (s) => console.log(s) });
  console.log(format(out));
  const sw = require('./session-switch.cjs');
  console.log(sw.choiceReport(observed.summarize(observed.load())));
}

module.exports = { compare, runOnce, parseResult, parseArgs, format, DEFAULT_MODELS, MAX_BUDGET };
