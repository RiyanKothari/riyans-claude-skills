#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { score, formatCard, PARAMETERS } = require('./rubric.cjs');
const { projectDataDir } = require('../paths.cjs');

const LOG = process.env.SCORECARD_PATH
  || path.join(projectDataDir(), 'scorecards.jsonl');

function flag(args, name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
}

/** The project's own test command: coverage if it has one, otherwise plain tests. */
function pickTestCommand(dir = process.cwd()) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const scripts = pkg.scripts || {};
    if (scripts.coverage) return 'npm run coverage';
    if (scripts.test) return 'npm test';
  } catch {
    // No package.json: nothing to run, so the evidence gates stay closed.
  }
  return null;
}

/**
 * Evidence is gathered by running the suite, not by asking how it went.
 *
 * One coverage run, not a verify run plus a coverage run: `node --test
 * --experimental-test-coverage` emits the pass/fail counts and the coverage
 * table together, so the second execution was pure waste.
 */
function gatherEvidence() {
  const ev = { verifyRan: false };
  const cmd = pickTestCommand();
  if (!cmd) return Object.assign(ev, gatherTurnEvidence());

  let out = '';
  try {
    out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    ev.verifyRan = true;
  } catch (e) {
    out = `${e.stdout || ''}${e.stderr || ''}`;
    ev.verifyRan = true;
  }

  const pass = out.match(/^ℹ pass (\d+)/m);
  const fail = out.match(/^ℹ fail (\d+)/m);
  const tests = out.match(/^ℹ tests (\d+)/m);
  if (pass && tests) {
    ev.testsPass = Number(pass[1]);
    ev.testsTotal = Number(tests[1]);
    ev.testsFail = fail ? Number(fail[1]) : 0;
  }

  const cov = out.match(/all files\s*\|\s*([\d.]+)/);
  if (cov) ev.coveragePct = Number(cov[1]);

  Object.assign(ev, gatherTurnEvidence());
  return ev;
}

/**
 * This session's own transcript: `<projects>/<project>/<session id>.jsonl`.
 *
 * It used to take the newest transcript across every project, so whenever another
 * session wrote last, this turn was scored on that session's work: a turn that
 * shipped three test files and a SKILL.md scored durability 0, and efficiency was
 * inflated the same way. No session id means no turn evidence, which leaves those
 * parameters unbacked instead of guessed.
 *
 * @param {Record<string, string|undefined>} [env]
 * @param {string} [projectsDir]
 */
function sessionTranscript(env = process.env, projectsDir) {
  const id = String(env.CLAUDE_CODE_SESSION_ID || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!id) return null;
  try {
    const { findTranscripts } = require('../outcome/transcript.cjs');
    return findTranscripts(projectsDir).find((f) => path.basename(f) === `${id}.jsonl`) || null;
  } catch {
    return null;
  }
}

/**
 * Durability and efficiency read from the transcript rather than file mtimes.
 *
 * The mtime version used a one-hour window, which miscounts on a long or
 * resumed session. The transcript names exactly which files this turn touched
 * and how many tools it burned, so no time heuristic is needed.
 *
 * @param {string|null} [transcriptPath]
 * @returns {{testsAdded?: number, docsUpdated?: boolean, toolCount?: number, tier?: string}}
 */
function gatherTurnEvidence(transcriptPath) {
  const p = transcriptPath || sessionTranscript();
  if (!p) return {};

  let turn;
  try {
    const { lastTurn } = require('../outcome/transcript.cjs');
    turn = lastTurn(p);
  } catch {
    return {};
  }
  if (!turn) return {};

  const files = turn.files || [];
  const testsAdded = files.filter((f) => /\.test\.[cm]?js$/.test(f)).length;
  // In a skills repo most docs are SKILL.md and references/, not just README.
  // This scored a turn that updated two skill docs as "no docs".
  const docsUpdated = files.some((f) => /\.md$/i.test(f) && !/[\\/]memory[\\/]/.test(f));

  const out = {
    testsAdded,
    docsUpdated,
    toolCount: turn.edits + turn.commands + turn.reads,
  };

  try {
    const { actualTier } = require('../outcome/score.cjs');
    out.tier = actualTier(turn);
  } catch {
    // Without a tier the efficiency gate simply stays unbacked.
  }

  return out;
}

function readLog() {
  try {
    return fs
      .readFileSync(LOG, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function appendLog(entry) {
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.appendFileSync(LOG, `${JSON.stringify(entry)}\n`, 'utf8');
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  if (cmd === 'score') {
    const title = flag(rest, 'title', 'Task');
    const manual = {};
    const notes = {};
    for (const p of PARAMETERS) {
      const v = flag(rest, p.key, null);
      if (v !== null) manual[p.key] = Number(v);
      const n = flag(rest, `${p.key}-why`, null);
      if (n !== null) notes[p.key] = n;
    }

    const evidence = rest.includes('--no-run') ? {} : gatherEvidence();
    const result = score({ ...manual, notes, evidence });

    console.log(formatCard(result, title));
    if (evidence.testsTotal) {
      console.log(`\nevidence: ${evidence.testsPass}/${evidence.testsTotal} tests` +
        (evidence.coveragePct ? `, ${evidence.coveragePct}% coverage` : ''));
    }

    appendLog({
      at: Date.now(),
      title,
      total: result.total,
      weakest: result.weakest ? result.weakest.key : null,
      weakestLost: result.weakest ? result.weakest.lost : 0,
      breakdown: result.breakdown.map((b) => ({ k: b.key, v: b.value })),
    });
    return;
  }

  if (cmd === 'trend') {
    const rows = readLog().slice(-Number(flag(rest, 'last', '10')));
    if (!rows.length) { console.log('no scorecards yet'); return; }

    console.log('score  weakest            title');
    for (const r of rows) {
      console.log(
        `${String(r.total).padStart(5)}  ${String(r.weakest || '-').padEnd(18)} ${r.title}`,
      );
    }

    // A parameter that keeps coming up weakest is a habit, not an accident.
    const counts = {};
    for (const r of readLog()) {
      if (r.weakest) counts[r.weakest] = (counts[r.weakest] || 0) + 1;
    }
    const repeat = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    if (repeat && repeat[1] > 1) {
      console.log(`\nrecurring weak spot: ${repeat[0]} (${repeat[1]}x) - this is a pattern, fix the habit`);
    }
    return;
  }

  console.log('Usage: cli.cjs <score|trend> [options]');
  console.log('  score --title "..." [--scopeFit 8] [--scopeFit-why "..."] [--no-run]');
  console.log('  trend [--last 10]');
  console.log('\nParameters:');
  for (const p of PARAMETERS) console.log(`  ${p.key.padEnd(14)} w=${p.weight}  ${p.asks}`);
}

if (require.main === module) main();

module.exports = { sessionTranscript, gatherTurnEvidence, pickTestCommand };
