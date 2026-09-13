'use strict';

const fs = require('fs');
const path = require('path');

// A skill is prose, so nothing about it is checked by the type system or the
// test runner unless something like this does it. These are the failure modes
// that actually stop a skill working.
const LIMITS = {
  maxLines: 400,
  minDescriptionWords: 12,
  maxDescriptionWords: 60,
  maxNameLength: 40,
};

// UTF-8 read back as Windows-1252 (what PowerShell produced in this repo) or as
// Latin-1. The first version knew only the Latin-1 shapes, and passed a published
// skill whose arrows GitHub was rendering as garbage.
const MOJIBAKE = /\u00e2\u20ac|\u00e2\u2020|\u00c3[\u00a0-\u00bf]|\u00ef\u00bb\u00bf|\u00e2[\u0080-\u009f]/;

const SECRET_SHAPES = [
  /\bsk-ant-api03-(?!x{8}|y{8})[A-Za-z0-9_-]{16,}/,
  /\brzp_(?:test|live)_(?!0{8})[A-Za-z0-9]{10,}/,
  /\bAIza(?!x{8})[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_(?!x{8})[A-Za-z0-9]{20,}/,
];

function parseFrontmatter(text) {
  const fields = {};
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  // Always return a fields object so callers never have to narrow a union.
  if (!m) return { ok: false, error: 'no YAML frontmatter block', fields, raw: '', body: text };

  let key = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-zA-Z_][\w-]*):\s*(.*)$/);
    if (kv) {
      key = kv[1];
      fields[key] = kv[2].trim();
    } else if (key && /^\s+\S/.test(line)) {
      // Folded continuation of the previous value.
      fields[key] = `${fields[key]} ${line.trim()}`.trim();
    }
  }
  return { ok: true, error: '', fields, raw: m[1], body: text.slice(m[0].length) };
}

function lintSkill(dir) {
  const name = path.basename(dir);
  const file = path.join(dir, 'SKILL.md');
  const errors = [];
  const warnings = [];

  if (!fs.existsSync(file)) {
    return { name, file, errors: ['SKILL.md missing'], warnings };
  }

  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n').length;

  const fm = parseFrontmatter(text);
  if (!fm.ok) {
    errors.push(fm.error);
    return { name, file, errors, warnings, lines };
  }

  const { fields } = fm;

  if (!fields.name) errors.push('frontmatter missing `name`');
  else {
    if (fields.name !== name) {
      errors.push(`name "${fields.name}" does not match directory "${name}"`);
    }
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(fields.name)) {
      errors.push(`name "${fields.name}" is not kebab-case`);
    }
    if (fields.name.length > LIMITS.maxNameLength) {
      errors.push(`name longer than ${LIMITS.maxNameLength} chars`);
    }
  }

  if (!fields.description) {
    errors.push('frontmatter missing `description`');
  } else {
    const words = fields.description.split(/\s+/).filter(Boolean).length;
    // The description is the only thing the model sees when deciding whether
    // to load a skill, so an under-specified one silently never triggers.
    if (words < LIMITS.minDescriptionWords) {
      errors.push(`description is ${words} words; too thin to trigger reliably`);
    }
    if (words > LIMITS.maxDescriptionWords) {
      warnings.push(`description is ${words} words (soft limit ${LIMITS.maxDescriptionWords})`);
    }
    // "Use when", "Use before", "whenever", "Use after" are all valid ways to
    // state a trigger. Requiring one exact phrasing flagged good descriptions.
    if (!/\b(use (when|before|after|during)|whenever|when you|when the)\b/i.test(fields.description)) {
      errors.push('description does not say WHEN to use the skill');
    }
    if (/[<>]/.test(fields.description)) {
      errors.push('description contains angle brackets, which break frontmatter');
    }
  }

  if (lines > LIMITS.maxLines) {
    warnings.push(`${lines} lines (limit ${LIMITS.maxLines}) — move detail into references/`);
  }

  if (MOJIBAKE.test(text)) {
    errors.push('mojibake detected — file was round-tripped through a bad encoding');
  }

  for (const re of SECRET_SHAPES) {
    if (re.test(text)) errors.push('possible real credential in skill text');
  }

  // Every referenced file must exist, or the progressive-disclosure promise is
  // a dead link.
  for (const m of text.matchAll(/`(references\/[\w./-]+\.md)`/g)) {
    if (!fs.existsSync(path.join(dir, m[1]))) {
      errors.push(`referenced file does not exist: ${m[1]}`);
    }
  }

  return { name, file, errors, warnings, lines, fields };
}

function lintAll(skillsDir) {
  if (!fs.existsSync(skillsDir)) return { skills: [], errors: 1, warnings: 0 };

  const skills = fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => lintSkill(path.join(skillsDir, e.name)));

  return {
    skills,
    errors: skills.reduce((a, s) => a + s.errors.length, 0),
    warnings: skills.reduce((a, s) => a + s.warnings.length, 0),
  };
}

function formatReport(result) {
  const L = [];
  for (const s of result.skills) {
    const status = s.errors.length ? 'FAIL' : s.warnings.length ? 'warn' : 'ok  ';
    L.push(`${status}  ${s.name.padEnd(24)} ${s.lines || '?'} lines`);
    for (const e of s.errors) L.push(`        error: ${e}`);
    for (const w of s.warnings) L.push(`        warn:  ${w}`);
  }
  L.push('');
  L.push(`${result.skills.length} skill(s), ${result.errors} error(s), ${result.warnings} warning(s)`);
  return L.join('\n');
}

module.exports = { lintSkill, lintAll, formatReport, parseFrontmatter, LIMITS };
