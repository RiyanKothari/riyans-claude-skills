#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');
const { score, formatCard, PARAMETERS } = require('./rubric.cjs');
const { projectDataDir } = require('../paths.cjs');

const LOG = process.env.SCORECARD_PATH
  || path.join(projectDataDir(), 'scorecards.jsonl');

function flag(args, name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Whether `dir` carries pytest configuration, not merely a Python file. */
function hasPytestConfig(dir) {
  if (fs.existsSync(path.join(dir, 'pytest.ini'))) return true;
  const pyproject = readText(path.join(dir, 'pyproject.toml'));
  if (pyproject && /^\[tool\.pytest(\.ini_options)?\]/m.test(pyproject)) return true;
  const setupCfg = readText(path.join(dir, 'setup.cfg'));
  return Boolean(setupCfg && /^\[tool:pytest\]/m.test(setupCfg));
}

/** The project's venv interpreter if it has one, otherwise whatever `python` is on PATH. */
function pythonFor(dir, platform) {
  const rel = platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python'];
  for (const venv of ['.venv', 'venv']) {
    const p = path.join(dir, venv, ...rel);
    if (fs.existsSync(p)) return p;
  }
  return 'python';
}

/**
 * The project's own test command: coverage if it has one, otherwise plain tests.
 *
 * A Python project scored 10/100 with 38 of 38 pytest tests green, because only
 * package.json was consulted. pytest config in the project root or one directory
 * down (a `backend/` beside a frontend) now counts, run from that directory.
 *
 * @param {string} [dir]
 * @param {string} [platform]
 * @returns {{ runner: 'node', command: string, cwd: string }
 *   | { runner: 'pytest', file: string, args: string[], cwd: string } | null}
 */
function pickTestCommand(dir = process.cwd(), platform = process.platform) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const scripts = pkg.scripts || {};
    if (scripts.coverage) return { runner: 'node', command: 'npm run coverage', cwd: dir };
    if (scripts.test) return { runner: 'node', command: 'npm test', cwd: dir };
  } catch {
    // No package.json: fall through to Python.
  }

  let candidates = [dir];
  try {
    const skip = new Set(['node_modules', 'venv']);
    const subdirs = fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !skip.has(d.name))
      .map((d) => path.join(dir, d.name))
      .sort();
    candidates = candidates.concat(subdirs);
  } catch {
    // Unreadable directory: only the root itself is a candidate.
  }
  const project = candidates.find(hasPytestConfig);
  if (project) {
    return { runner: 'pytest', file: pythonFor(project, platform), args: ['-m', 'pytest'], cwd: project };
  }

  // Nothing to run, so the evidence gates stay closed.
  return null;
}

/** Which way each pytest outcome counts. Skipped, deselected and warnings did not pass or fail. */
const PYTEST_BUCKET = {
  passed: 'pass', xfailed: 'pass', xpassed: 'pass',
  failed: 'fail', error: 'fail', errors: 'fail',
  skipped: null, deselected: null, warning: null, warnings: null, rerun: null,
};

/**
 * Counts from pytest's final summary line, with or without `-q`:
 * `==== 1 failed, 36 passed in 44.44s ====` or `38 passed, 2 warnings in 31.51s`.
 *
 * Collection and fixture errors count as failures. Returns null when there is
 * no summary line at all: a missing interpreter is not a test result.
 *
 * @param {string} out
 * @returns {{ testsPass: number, testsFail: number, testsTotal: number } | null}
 */
function parsePytestSummary(out) {
  const lines = String(out).replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).reverse();
  for (const raw of lines) {
    const line = raw.replace(/^=+\s*|\s*=+$/g, '').replace(/ in [\d.]+s\b.*$/, '').trim();
    if (line === 'no tests ran') return { testsPass: 0, testsFail: 0, testsTotal: 0 };
    if (!line) continue;

    const counts = { pass: 0, fail: 0 };
    const recognised = line.split(', ').every((part) => {
      const m = part.match(/^(\d+) ([a-z]+)$/);
      if (!m || !(m[2] in PYTEST_BUCKET)) return false;
      const bucket = PYTEST_BUCKET[m[2]];
      if (bucket) counts[bucket] += Number(m[1]);
      return true;
    });
    if (!recognised) continue;
    return { testsPass: counts.pass, testsFail: counts.fail, testsTotal: counts.pass + counts.fail };
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
  const picked = pickTestCommand();
  if (!picked) return Object.assign(ev, gatherTurnEvidence());

  if (picked.runner === 'pytest') {
    let out = '';
    try {
      // No shell: the interpreter path may contain spaces.
      out = execFileSync(picked.file, picked.args, {
        cwd: picked.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
      });
    } catch (e) {
      // pytest exits non-zero on any failure; the summary still says what ran.
      out = `${e.stdout || ''}${e.stderr || ''}`;
    }
    const counts = parsePytestSummary(out);
    // Only a suite that actually ran tests opens the gates: a missing
    // interpreter, or "no tests ran", measured nothing.
    if (counts && counts.testsTotal > 0) {
      Object.assign(ev, counts);
      ev.verifyRan = true;
    }
    return Object.assign(ev, gatherTurnEvidence());
  }

  let out = '';
  try {
    out = execSync(picked.command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
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
 * @returns {{testsAdded?: number, docsUpdated?: boolean, sourcesChanged?: number, untested?: string[], toolCount?: number, tier?: string}}
 */
function gatherTurnEvidence(transcriptPath, cwd = process.cwd()) {
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

  // Files written by a script run through Bash never appear as Edit or Write calls,
  // so a turn that patched four test files in one command scored as adding one.
  // The transcript names files absolutely and git relatively, so one file was counted
  // twice until both were resolved to the same key.
  const byKey = new Map();
  for (const f of [...(turn.files || []), ...gitFilesSince(turn.timestamp, cwd)]) {
    const abs = path.resolve(cwd, f);
    byKey.set(process.platform === 'win32' ? abs.toLowerCase() : abs, abs);
  }
  const files = [...byKey.values()];
  const testsAdded = files.filter((f) => TEST_FILE.test(f)).length;
  // In a skills repo most docs are SKILL.md and references/, not just README.
  // This scored a turn that updated two skill docs as "no docs".
  const docsUpdated = files.some((f) => /\.md$/i.test(f) && !/[\\/]memory[\\/]/.test(f));

  /** @type {{testsAdded: number, docsUpdated: boolean, sourcesChanged: number, untested: string[], toolCount: number, tier?: string}} */
  const out = {
    testsAdded,
    docsUpdated,
    ...testedSources(files, cwd),
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

const TEST_FILE = /\.test\.[cm]?[jt]s$/;
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;

/** Every source file in the project, by basename. Bounded: node_modules is skipped. */
function repoIndex(cwd, limit = 4000) {
  const index = new Map();
  const walk = (dir) => {
    if (index.size > limit) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'coverage') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (SOURCE_FILE.test(e.name)) {
        if (!index.has(e.name)) index.set(e.name, []);
        index.get(e.name).push(p);
      }
    }
  };
  walk(cwd);
  return index;
}

const REQUIRE = /(?:require|from)\(?\s*['"](\.[^'"]+)['"]/g;

/** The files `entry` requires directly, resolved to real paths inside the project. */
function directRequires(entry) {
  let body;
  try {
    body = fs.readFileSync(entry, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const [, spec] of body.matchAll(REQUIRE)) {
    const base = path.resolve(path.dirname(entry), spec);
    for (const candidate of [base, `${base}.cjs`, `${base}.js`, path.join(base, 'index.cjs')]) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        out.push(candidate);
        break;
      }
    }
  }
  return out;
}

/**
 * Which changed modules no changed test exercises. Durability is whether each change
 * is pinned by a test, not how many test files moved: the old count scored one
 * thorough test of the one module changed below six test files touched in passing.
 * Files outside the project (scratch scripts) and deleted files are not the
 * project's code.
 *
 * A test exercises a module when it names the module's file, or names an entry
 * point that requires it directly — a hook or CLI test drives its own dependencies,
 * and scoring only literal name matches reported those changes as untested. One
 * level, not the whole tree: running a module is not the same as pinning it.
 *
 * @param {string[]} files absolute paths
 * @param {string} cwd
 * @returns {{sourcesChanged: number, untested: string[]}}
 */
function testedSources(files, cwd) {
  const { isInside } = require('../paths.cjs');
  const bodies = files.filter((f) => TEST_FILE.test(f)).map((t) => {
    try {
      return fs.readFileSync(t, 'utf8');
    } catch {
      return '';
    }
  });
  const sources = files.filter((f) => SOURCE_FILE.test(f) && !TEST_FILE.test(f)
    && !/[\\/]node_modules[\\/]/.test(f) && isInside(f, cwd) && fs.existsSync(f));

  const named = (f) => bodies.some((b) => b.includes(path.basename(f)));
  const reached = new Set();
  if (sources.some((s) => !named(s))) {
    for (const [base, paths] of repoIndex(cwd)) {
      if (!bodies.some((b) => b.includes(base))) continue;
      for (const entry of paths) for (const dep of directRequires(entry)) reached.add(dep);
    }
  }

  const untested = sources
    .filter((s) => !named(s) && !reached.has(path.resolve(s)))
    .map((s) => path.relative(cwd, s).replace(/\\/g, '/'));
  return { sourcesChanged: sources.length, untested };
}

/**
 * Files git says changed since the turn began: committed since then, or modified
 * since then and still uncommitted. Empty outside a git repository.
 *
 * @param {string|null|undefined} since ISO timestamp of the turn's prompt
 * @param {string} cwd
 * @returns {string[]}
 */
function gitFilesSince(since, cwd) {
  const start = Date.parse(String(since || ''));
  if (!start) return [];
  // Each query fails on its own: `git log` errors in a repo with no commits yet, and
  // that used to discard the uncommitted files too.
  const git = (args) => {
    try {
      return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return '';
    }
  };
  const committed = git(['log', `--since=${new Date(start).toISOString()}`, '--name-only', '--pretty=format:']);
  // Without --untracked-files=all a new directory is one entry ("src/"), and every
  // file created inside it went uncounted.
  const pending = git(['status', '--porcelain', '--untracked-files=all'])
    .split('\n')
    .map((l) => l.slice(3).trim())
    .filter((f) => {
      try {
        return f && fs.statSync(path.join(cwd, f)).mtimeMs >= start;
      } catch {
        return false;
      }
    });
  return [...committed.split('\n').map((l) => l.trim()).filter(Boolean), ...pending];
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
    if (evidence.untested && evidence.untested.length) {
      console.log(`no changed test exercises: ${evidence.untested.join(', ')}`);
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

module.exports = { sessionTranscript, gatherTurnEvidence, testedSources, pickTestCommand, parsePytestSummary };
