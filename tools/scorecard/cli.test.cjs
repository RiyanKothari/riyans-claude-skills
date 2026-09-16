'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sessionTranscript, gatherTurnEvidence, pickTestCommand, parsePytestSummary } = require('./cli.cjs');

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
