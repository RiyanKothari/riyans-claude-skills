'use strict';

const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage',
  '.claude-flow', '.swarm', '.next', 'out', 'vendor',
]);

const CODE_EXT = new Set([
  '.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx', '.py', '.go',
  '.rs', '.java', '.rb', '.php', '.c', '.h', '.cpp', '.cs',
]);

const PATH_RE = /(?:^|[\s"'`(])([\w./-]+\.[a-z]{1,4})(?=$|[\s"'`),.:])/gi;
const MAX_SCAN = 400;

function extractPaths(prompt) {
  const found = new Set();
  for (const m of String(prompt ?? '').matchAll(PATH_RE)) {
    const candidate = m[1];
    if (candidate && candidate.includes('.') && !candidate.startsWith('.')) {
      found.add(candidate.replace(/^\.\//, ''));
    }
  }
  return [...found];
}

function walk(root, out = [], budget = { n: MAX_SCAN }) {
  if (budget.n <= 0) return out;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (budget.n <= 0) break;
    if (e.name.startsWith('.') && e.name !== '.claude') continue;
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(full, out, budget);
    } else if (CODE_EXT.has(path.extname(e.name))) {
      out.push(full);
      budget.n--;
    }
  }
  return out;
}

function resolveInRepo(root, rel) {
  const direct = path.join(root, rel);
  if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;

  const base = path.basename(rel);
  for (const f of walk(root)) {
    if (path.basename(f) === base) return f;
  }
  return null;
}

function countImporters(root, filePath) {
  const stem = path.basename(filePath, path.extname(filePath));
  if (!stem || stem.length < 3) return 0;
  const needle = new RegExp(`['"\`/]${stem}(?:['"\`./]|$)`, 'm');

  let count = 0;
  for (const f of walk(root)) {
    if (f === filePath) continue;
    try {
      if (needle.test(fs.readFileSync(f, 'utf8'))) count++;
    } catch {
      // Unreadable file just does not count as an importer.
    }
  }
  return count;
}

const cache = new Map();

function fileFacts(root, rel) {
  const key = `${root}::${rel}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const resolved = resolveInRepo(root, rel);
  if (!resolved) {
    const miss = { path: rel, exists: false, lines: 0, importers: 0 };
    cache.set(key, miss);
    return miss;
  }

  let lines = 0;
  try {
    lines = fs.readFileSync(resolved, 'utf8').split('\n').length;
  } catch {
    lines = 0;
  }

  const facts = {
    path: path.relative(root, resolved).replace(/\\/g, '/'),
    exists: true,
    lines,
    importers: countImporters(root, resolved),
  };
  cache.set(key, facts);
  return facts;
}

// A small prompt about a large, widely-imported file is not a small task.
function repoSignal(prompt, opts = {}) {
  const root = opts.root || process.cwd();
  const mentioned = extractPaths(prompt);
  if (!mentioned.length) return { score: 0, files: [], reason: 'no file mentioned' };

  const files = mentioned.slice(0, 4).map((rel) => fileFacts(root, rel));
  const present = files.filter((f) => f.exists);
  if (!present.length) return { score: 0, files, reason: 'named files not found in repo' };

  let score = 0;
  const maxLines = Math.max(...present.map((f) => f.lines));
  const maxImporters = Math.max(...present.map((f) => f.importers));

  if (maxLines > 500) score += 2;
  else if (maxLines > 200) score += 1;

  if (maxImporters > 10) score += 2;
  else if (maxImporters > 3) score += 1;

  if (present.length > 2) score += 1;

  return {
    score,
    files: present,
    reason: `${present.length} file(s), max ${maxLines} lines, max ${maxImporters} importers`,
  };
}

function clearCache() {
  cache.clear();
}

module.exports = { repoSignal, extractPaths, fileFacts, clearCache };
