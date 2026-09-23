'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sessionTranscript, gatherTurnEvidence, pickTestCommand, parsePytestSummary, testedSources, coverageArgs } = require('./cli.cjs');

const human = (content) => ({ type: 'user', promptSource: 'sdk', origin: { kind: 'human' }, message: { content } });
const wrote = (file) => ({
  type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: file } }] },
});

function projects() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scorecard-projects-'));
  const put = (dir, id, lines) => {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    const p = path.join(root, dir, `${id}.jsonl`);
    fs.writeFileSync(p, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    return p;
  };
  return { root, put, clean: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('evidence comes from this session, even when another project wrote last', () => {
  // Found live: another project's session was newest, its turn had no tests or
  // docs, and a turn that shipped three test files and a SKILL.md scored durability 0.
  const p = projects();
  const mine = p.put('C--work-harness', 'sess-mine', [
    human('add the loop'), wrote('/r/tools/loop.test.cjs'), wrote('/r/skills/x/SKILL.md'),
  ]);
  const other = p.put('C--work-other', 'sess-other', [human('unrelated'), wrote('/o/main.py')]);
  const later = new Date(Date.now() + 60000);
  fs.utimesSync(other, later, later);

  const found = sessionTranscript({ CLAUDE_CODE_SESSION_ID: 'sess-mine' }, p.root);
  assert.strictEqual(found, mine);
  const ev = gatherTurnEvidence(found);
  assert.strictEqual(ev.testsAdded, 1);
  assert.strictEqual(ev.docsUpdated, true);
  p.clean();
});

test('outside a session the turn evidence stays unmeasured rather than guessed', () => {
  const p = projects();
  p.put('C--work-other', 'sess-other', [human('unrelated'), wrote('/o/a.test.js')]);
  assert.strictEqual(sessionTranscript({}, p.root), null);
  assert.strictEqual(sessionTranscript({ CLAUDE_CODE_SESSION_ID: 'no-such-session' }, p.root), null);
  p.clean();
});

test('a hostile session id cannot select another file', () => {
  const p = projects();
  p.put('C--work-other', 'victim', [human('x')]);
  assert.strictEqual(sessionTranscript({ CLAUDE_CODE_SESSION_ID: '../C--work-other/victim' }, p.root), null);
  p.clean();
});

test('test files a script wrote through Bash count, whether committed or not', () => {
  const { execFileSync } = require('node:child_process');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-git-'));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: repo, stdio: 'ignore' });
  git('init', '-q');
  // Left uncommitted from before the turn: not this turn's work.
  fs.writeFileSync(path.join(repo, 'old.test.cjs'), '');
  const before = new Date(Date.now() - 3600000);
  fs.utimesSync(path.join(repo, 'old.test.cjs'), before, before);

  const tp = path.join(repo, 'transcript.jsonl');
  const prompt = { ...human('patch the tests'), timestamp: new Date(Date.now() - 60000).toISOString() };
  fs.writeFileSync(tp, `${JSON.stringify(prompt)}\n${JSON.stringify(wrote(path.join(repo, 'README.md')))}\n`);

  fs.writeFileSync(path.join(repo, 'a.test.cjs'), '');
  git('add', 'a.test.cjs');
  git('commit', '-q', '-m', 'patched by script');
  fs.writeFileSync(path.join(repo, 'b.test.cjs'), '');

  const ev = gatherTurnEvidence(tp, repo);
  assert.strictEqual(ev.testsAdded, 2);
  assert.strictEqual(ev.docsUpdated, true);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('each changed module is checked for a changed test that names it', () => {
  const { execFileSync } = require('node:child_process');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-src-'));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-scratch-'));
  execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'parse.cjs'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(repo, 'src', 'render.cjs'), 'module.exports = 2;\n');
  fs.writeFileSync(path.join(repo, 'src', 'parse.test.cjs'), "require('./parse.cjs');\n");
  fs.writeFileSync(path.join(scratch, 'patch.cjs'), '');

  const tp = path.join(repo, 'transcript.jsonl');
  const prompt = { ...human('change both'), timestamp: new Date(Date.now() - 60000).toISOString() };
  // The transcript's absolute path and git's relative one are the same test file.
  const lines = [prompt, wrote(path.join(repo, 'src', 'parse.test.cjs')), wrote(path.join(scratch, 'patch.cjs'))];
  fs.writeFileSync(tp, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);

  const ev = gatherTurnEvidence(tp, repo);
  assert.strictEqual(ev.testsAdded, 1, 'one test file, counted once');
  assert.strictEqual(ev.sourcesChanged, 2, 'a scratch script outside the project is not its code');
  assert.deepStrictEqual(ev.untested, ['src/render.cjs']);
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(scratch, { recursive: true, force: true });
});

test('pytest summary lines become pass, fail and total counts', () => {
  // Found live: 38 of 38 pytest tests green, and the scorecard said 10/100.
  assert.deepStrictEqual(parsePytestSummary('collected 38 items\n\n38 passed, 2 warnings in 31.51s\n'),
    { testsPass: 38, testsFail: 0, testsTotal: 38 });
  assert.deepStrictEqual(parsePytestSummary('....\r\n=================== 38 passed in 1.02s ===================\r\n'),
    { testsPass: 38, testsFail: 0, testsTotal: 38 });
  // -qq drops the timing.
  assert.deepStrictEqual(parsePytestSummary('38 passed\n'), { testsPass: 38, testsFail: 0, testsTotal: 38 });
});

test('a red pytest run reports its failures and errors, and skips count for nothing', () => {
  const out = [
    'FAILED tests/test_mine.py::test_window - AssertionError: 2 passed',
    '========== 1 failed, 36 passed in 44.44s (0:00:44) ==========',
  ].join('\n');
  assert.deepStrictEqual(parsePytestSummary(out), { testsPass: 36, testsFail: 1, testsTotal: 37 });

  assert.deepStrictEqual(parsePytestSummary('2 failed, 5 passed, 3 skipped, 1 xfailed, 1 error in 2.00s'),
    { testsPass: 6, testsFail: 3, testsTotal: 9 });
  // A collection error with nothing run is a failure, not an absence of evidence.
  assert.deepStrictEqual(parsePytestSummary('!!! Interrupted: 1 error during collection !!!\n==== 1 error in 0.30s ===='),
    { testsPass: 0, testsFail: 1, testsTotal: 1 });
});

test('no pytest summary is no evidence, and "no tests ran" measures nothing', () => {
  assert.strictEqual(parsePytestSummary(''), null);
  assert.strictEqual(parsePytestSummary("'python' is not recognized as an internal or external command"), null);
  assert.strictEqual(parsePytestSummary('ℹ tests 5\nℹ pass 5\n'), null);
  assert.deepStrictEqual(parsePytestSummary('==== no tests ran in 0.01s ===='), { testsPass: 0, testsFail: 0, testsTotal: 0 });
});

test('a Python project is found in the root or one directory down, with its own venv', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scorecard-py-'));
  /** @param {string} [platform] */
  const pick = (platform) => /** @type {any} */ (pickTestCommand(root, platform));
  const put = (rel, text = '') => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  try {
    assert.strictEqual(pickTestCommand(root), null);

    // A pyproject with no pytest config is not a pytest project.
    put('backend/pyproject.toml', '[project]\nname = "x"\n');
    assert.strictEqual(pickTestCommand(root), null);

    put('backend/pyproject.toml', '[project]\nname = "x"\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n');
    const bare = pickTestCommand(root, 'linux');
    assert.deepStrictEqual(bare, { runner: 'pytest', file: 'python', args: ['-m', 'pytest'], cwd: path.join(root, 'backend') });

    put('backend/.venv/Scripts/python.exe');
    assert.strictEqual(pick('win32').file, path.join(root, 'backend', '.venv', 'Scripts', 'python.exe'));
    assert.strictEqual(pick('linux').file, 'python');
    put('backend/.venv/bin/python');
    assert.strictEqual(pick('linux').file, path.join(root, 'backend', '.venv', 'bin', 'python'));

    // The root wins over a subdirectory, and setup.cfg / pytest.ini count too.
    put('setup.cfg', '[metadata]\nname = x\n\n[tool:pytest]\naddopts = -q\n');
    assert.strictEqual(pick('linux').cwd, root);
    fs.rmSync(path.join(root, 'setup.cfg'));
    put('pytest.ini', '[pytest]\n');
    assert.strictEqual(pick('linux').cwd, root);

    // Node behaviour is unchanged: a package.json test script still comes first.
    put('package.json', JSON.stringify({ scripts: { test: 'node --test' } }));
    assert.deepStrictEqual(pickTestCommand(root), { runner: 'node', command: 'npm test', cwd: root });
    put('package.json', JSON.stringify({ scripts: { test: 'node --test', coverage: 'c8' } }));
    assert.strictEqual(pick().command, 'npm run coverage');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a change is pinned by a test that names it, or names what requires it', () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'tested-sources-'));
  const w = (rel, body) => {
    const p = path.join(proj, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
    return p;
  };
  const hook = w('tools/hook.cjs', "require('./guard.cjs');\n");
  const guard = w('tools/guard.cjs', "require('./deep.cjs');\n");
  const deep = w('tools/deep.cjs', 'module.exports = 1;\n');
  const lonely = w('tools/lonely.cjs', 'module.exports = 2;\n');
  const spec = w('tools/hook.test.cjs', "spawnSync(node, [path.join(__dirname, 'hook.cjs')]);\n");

  const { sourcesChanged, untested } = testedSources([hook, guard, deep, lonely, spec], proj);
  assert.strictEqual(sourcesChanged, 4, 'the test file itself is not a source');
  // hook is named outright; guard is what the named entry point requires.
  assert.deepStrictEqual(untested.sort(), ['tools/deep.cjs', 'tools/lonely.cjs']);
});

test('turn evidence carries the file count efficiency is judged against', () => {
  // The allowance is max(tier floor, 4 per distinct file). If this field ever
  // stopped being reported, every large turn would silently fall back to the tier
  // floor and score 0 again — which is exactly the bug it was added to fix.
  const p = projects();
  const mine = p.put('C--work-harness', 'sess-files', [
    human('touch a few files'),
    wrote('/w/a.cjs'), wrote('/w/b.cjs'), wrote('/w/a.cjs'), wrote('/w/c.test.cjs'),
  ]);
  const ev = gatherTurnEvidence(mine, '/w');
  assert.strictEqual(ev.distinctFiles, 3, 'the same file twice is one file');
  assert.strictEqual(ev.toolCount, 4, 'but both calls still cost');
  p.clean();
});

test('a React test file is a test, not one more untested source', () => {
  // `.test.tsx` matched neither the test pattern nor a require, so writing a test for a
  // component made durability worse: the test counted as a second unpinned module.
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'tested-tsx-'));
  const w = (rel, body) => {
    const p = path.join(proj, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
    return p;
  };
  const page = w('src/pages/ReviewsPage.tsx', 'export function ReviewsPage() { return null }\n');
  const spec = w('src/pages/ReviewsPage.test.tsx', "import { ReviewsPage } from './ReviewsPage'\n");
  const other = w('src/pages/TrialPage.tsx', 'export function TrialPage() { return null }\n');

  const { sourcesChanged, untested } = testedSources([page, spec, other], proj);
  assert.strictEqual(sourcesChanged, 2, 'the .test.tsx file is not a source');
  assert.deepStrictEqual(untested, ['src/pages/TrialPage.tsx'], 'the extensionless import still pins the page');
});

test('a Python change is pinned by the test that imports its module', () => {
  // Python was invisible to both patterns, so a backend turn's changes were never weighed.
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'tested-py-'));
  const w = (rel, body) => {
    const p = path.join(proj, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
    return p;
  };
  w('precedent/__init__.py', '');
  const mod = w('precedent/bq.py', 'class BigQueryCasebook: pass\n');
  const untouched = w('precedent/trial.py', 'def score_run(): pass\n');
  const spec = w('tests/test_bq.py', 'from precedent.bq import BigQueryCasebook\n');

  const { sourcesChanged, untested } = testedSources([mod, untouched, spec], proj);
  assert.strictEqual(sourcesChanged, 2, 'test_bq.py is a test, not a source');
  assert.deepStrictEqual(untested, ['precedent/trial.py']);
});

test('pytest is asked for coverage only when the plugin is there', () => {
  // Asking for --cov without pytest-cov makes pytest exit on an unrecognised argument,
  // which would close every evidence gate instead of opening one.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pytest-cov-'));
  fs.writeFileSync(path.join(root, 'pyproject.toml'), '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n');
  const picked = /** @type {any} */ (pickTestCommand(root));
  assert.strictEqual(picked.runner, 'pytest');
  // No interpreter here can import pytest_cov, so the plain command is the safe answer.
  assert.deepStrictEqual(picked.args, ['-m', 'pytest']);
});

test('coverage measures the project packages, not its own tests', () => {
  // A bare --cov counts test files, which are 100% covered by definition: it read 91%
  // where the package alone was 87%.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cov-target-'));
  fs.mkdirSync(path.join(root, 'precedent'));
  fs.mkdirSync(path.join(root, 'tests'));
  fs.writeFileSync(path.join(root, 'precedent', '__init__.py'), '');
  fs.writeFileSync(path.join(root, 'tests', '__init__.py'), '');
  assert.deepStrictEqual(coverageArgs(root), ['--cov=precedent', '--cov-report=term']);

  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'cov-bare-'));
  assert.deepStrictEqual(coverageArgs(bare), ['--cov', '--cov-report=term'], 'no package: measure everything');
});
