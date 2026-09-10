#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { score, formatCard, PARAMETERS } = require('./rubric.cjs');

const LOG = process.env.SCORECARD_PATH
  || path.join(process.cwd(), '.claude', 'memory', 'scorecards.jsonl');

function flag(args, name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
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
  let out = '';
  try {
    out = execSync('npm run coverage', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
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

function newestTranscript() {
  try {
    const { findTranscripts } = require('../outcome/transcript.cjs');
    const files = findTranscripts();
    let best = null;
    let bestAt = 0;
    for (const f of files) {
      const m = fs.statSync(f).mtimeMs;
      if (m > bestAt) { bestAt = m; best = f; }
    }
    return best;
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
 */
function gatherTurnEvidence(transcriptPath) {
  const p = transcriptPath || newestTranscript();
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
  const docsUpdated = files.some((f) => /(README|CLAUDE)\.md$/i.test(f));

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

main();
