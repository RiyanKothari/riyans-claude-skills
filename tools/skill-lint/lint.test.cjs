'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { lintSkill, lintAll, parseFrontmatter, LIMITS } = require('./lint.cjs');

const GOOD_DESC = 'Does a useful thing for the project. Use when you need that thing done properly.';

function skillDir(name, body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-'));
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  if (body !== null) fs.writeFileSync(path.join(dir, 'SKILL.md'), body);
  return { root, dir, clean: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function skill(fields, body = '# Title\n\ncontent\n') {
  const fm = Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n');
  return `---\n${fm}\n---\n\n${body}`;
}

test('a well-formed skill passes clean', () => {
  const f = skillDir('good-skill', skill({ name: 'good-skill', description: GOOD_DESC }));
  const r = lintSkill(f.dir);
  assert.deepStrictEqual(r.errors, []);
  f.clean();
});

test('a missing SKILL.md is an error', () => {
  const f = skillDir('empty-skill', null);
  assert.ok(lintSkill(f.dir).errors.some((e) => /missing/.test(e)));
  f.clean();
});

test('missing frontmatter is an error', () => {
  const f = skillDir('bare', '# Just markdown\n');
  assert.ok(lintSkill(f.dir).errors.some((e) => /frontmatter/.test(e)));
  f.clean();
});

test('frontmatter name must match the directory', () => {
  // Regression: a bulk rename rewrote the frontmatter name and the skill would
  // silently have stopped loading.
  const f = skillDir('real-name', skill({ name: 'other-name', description: GOOD_DESC }));
  assert.ok(lintSkill(f.dir).errors.some((e) => /does not match directory/.test(e)));
  f.clean();
});

test('a non-kebab-case name is rejected', () => {
  const f = skillDir('Bad_Name', skill({ name: 'Bad_Name', description: GOOD_DESC }));
  assert.ok(lintSkill(f.dir).errors.some((e) => /kebab-case/.test(e)));
  f.clean();
});

test('a description too thin to trigger is an error', () => {
  const f = skillDir('thin', skill({ name: 'thin', description: 'Does stuff. Use when needed.' }));
  assert.ok(lintSkill(f.dir).errors.some((e) => /too thin/.test(e)));
  f.clean();
});

test('a description with no trigger condition is an error', () => {
  const desc = 'This skill performs a number of generally useful operations across the project codebase.';
  const f = skillDir('notrigger', skill({ name: 'notrigger', description: desc }));
  assert.ok(lintSkill(f.dir).errors.some((e) => /WHEN/.test(e)));
  f.clean();
});

test('use-before and whenever count as valid triggers', () => {
  // These were false-flagged when the check required the literal "use when".
  for (const d of [
    'Rules for risky operations across the repository. Use before any destructive change lands.',
    'Guidance for tricky situations in this codebase. Apply whenever an operation is hard to undo.',
    'Helps with reviewing work carefully. Use after finishing a change but before reporting it done.',
  ]) {
    const f = skillDir('trig', skill({ name: 'trig', description: d }));
    assert.deepStrictEqual(lintSkill(f.dir).errors, [], `rejected: ${d.slice(0, 40)}`);
    f.clean();
  }
});

test('angle brackets in a description are rejected', () => {
  const f = skillDir('angle', skill({
    name: 'angle',
    description: `${GOOD_DESC} Handles <input> tags in a way that matters here.`,
  }));
  assert.ok(lintSkill(f.dir).errors.some((e) => /angle brackets/.test(e)));
  f.clean();
});

test('a broken references link is an error', () => {
  const body = '# T\n\nSee `references/missing.md` for detail.\n';
  const f = skillDir('refs', skill({ name: 'refs', description: GOOD_DESC }, body));
  assert.ok(lintSkill(f.dir).errors.some((e) => /does not exist/.test(e)));
  f.clean();
});

test('a references link that resolves passes', () => {
  const body = '# T\n\nSee `references/real.md` for detail.\n';
  const f = skillDir('refs2', skill({ name: 'refs2', description: GOOD_DESC }, body));
  fs.mkdirSync(path.join(f.dir, 'references'), { recursive: true });
  fs.writeFileSync(path.join(f.dir, 'references', 'real.md'), 'x');
  assert.deepStrictEqual(lintSkill(f.dir).errors, []);
  f.clean();
});

test('mojibake is caught', () => {
  // Regression: a bulk rewrite corrupted encodings and broke a regex silently.
  // Latin-1 shape of an em dash, built at runtime so this file stays clean.
  const body = `# T\n\nthis line has a broken em dash ${Buffer.from('—', 'utf8').toString('latin1')} here\n`;
  const f = skillDir('moji', skill({ name: 'moji', description: GOOD_DESC }, body));
  assert.ok(lintSkill(f.dir).errors.some((e) => /mojibake/.test(e)));
  f.clean();
});

test('Windows-1252 mojibake is caught', () => {
  // Regression: PowerShell turned an arrow into this three-character sequence in a
  // published skill, and the Latin-1-only check passed it.
  // Produce the corruption exactly as PowerShell did — UTF-8 bytes decoded as
  // Windows-1252 — so this file itself contains only correct characters.
  const cp1252 = (s) => new TextDecoder('windows-1252').decode(Buffer.from(s, 'utf8'));
  const arrow = cp1252('→');
  const dash = cp1252('—');
  for (const bad of [`Research${arrow}plan`, `Ruflo ${dash} config`]) {
    const f = skillDir('cp1252', skill({ name: 'cp1252', description: GOOD_DESC }, `# T\n\n${bad}\n`));
    assert.ok(lintSkill(f.dir).errors.some((e) => /mojibake/.test(e)), `missed: ${bad}`);
    f.clean();
  }
});

test('correct UTF-8 punctuation is not mistaken for mojibake', () => {
  const body = '# T\n\nResearch → plan — then build “quoted” café\n';
  const f = skillDir('clean-utf8', skill({ name: 'clean-utf8', description: GOOD_DESC }, body));
  assert.ok(!lintSkill(f.dir).errors.some((e) => /mojibake/.test(e)));
  f.clean();
});

test('a credential-shaped string in skill text is caught', () => {
  // Assembled at runtime so this file contains no literal key-shaped string.
  // A fixture that trips GitHub secret scanning is indistinguishable from a
  // real leak, and costs the same review time.
  const fakeKey = `${['sk', 'ant', 'api03'].join('-')}-${'Q'.repeat(24)}`;
  const body = `# T\n\nexample key ${fakeKey} here\n`;
  const f = skillDir('sec', skill({ name: 'sec', description: GOOD_DESC }, body));
  assert.ok(lintSkill(f.dir).errors.some((e) => /credential/.test(e)));
  f.clean();
});

test('an oversized skill warns but does not fail', () => {
  const body = `# T\n\n${'filler\n'.repeat(LIMITS.maxLines + 50)}`;
  const f = skillDir('big', skill({ name: 'big', description: GOOD_DESC }, body));
  const r = lintSkill(f.dir);
  assert.deepStrictEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => /references/.test(w)));
  f.clean();
});

test('frontmatter continuation lines are folded into the value', () => {
  const text = '---\nname: folded\ndescription: First part of it\n  and the continuation here\n---\n\nbody\n';
  const fm = parseFrontmatter(text);
  assert.ok(fm.ok);
  assert.match(fm.fields.description, /continuation/);
});

test('lintAll aggregates across every skill directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lintall-'));
  for (const n of ['one', 'two']) {
    fs.mkdirSync(path.join(root, n), { recursive: true });
    fs.writeFileSync(path.join(root, n, 'SKILL.md'), skill({ name: n, description: GOOD_DESC }));
  }
  const r = lintAll(root);
  assert.strictEqual(r.skills.length, 2);
  assert.strictEqual(r.errors, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('every shipped skill in this repo lints clean', () => {
  // The point of the whole file: prose ships with the same gate as code.
  const r = lintAll(path.join(__dirname, '..', '..', 'skills'));
  assert.ok(r.skills.length >= 5, `expected the shipped skills, found ${r.skills.length}`);
  const failing = r.skills.filter((s) => s.errors.length);
  assert.deepStrictEqual(
    failing.map((s) => `${s.name}: ${s.errors.join('; ')}`),
    [],
  );
});
