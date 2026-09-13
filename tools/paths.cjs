'use strict';

const os = require('os');
const path = require('path');

const HARNESS_ROOT = path.join(__dirname, '..');

function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** The project Claude Code is working in — the same rule the hooks use. */
function projectRoot(env = process.env, cwd = process.cwd()) {
  return env.CLAUDE_PROJECT_DIR || cwd;
}

/**
 * Where a project's memory, scorecards and handoff live.
 *
 * Inside the harness repo: its own gitignored .claude/memory. Anywhere else:
 * under ~/.claude, keyed by path — memory is built from prompts and must never be
 * written into another repo's working tree, where it could be committed.
 * Keep in step with dataDir() in .claude/helpers/learning-hook.cjs.
 */
function projectDataDir(projectDir = projectRoot()) {
  if (isInside(projectDir, HARNESS_ROOT)) return path.join(HARNESS_ROOT, '.claude', 'memory');
  const key = path.resolve(projectDir).replace(/[:\\/]+/g, '-').replace(/^-+|-+$/g, '');
  return path.join(os.homedir(), '.claude', 'token-harness', 'projects', key);
}

module.exports = { HARNESS_ROOT, isInside, projectRoot, projectDataDir };
