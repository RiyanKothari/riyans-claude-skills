'use strict';

const fs = require('fs');
const path = require('path');
const { classifyTool } = require('./score.cjs');

const PROJECTS_DIR = path.join(
  process.env.USERPROFILE || process.env.HOME || '',
  '.claude',
  'projects',
);

// A genuine human turn, as opposed to a tool result, hook injection or the
// assistant's own follow-up — all of which also arrive as type "user".
function isHumanPrompt(o) {
  return (
    o
    && o.type === 'user'
    && Boolean(o.promptSource)
    // Headless (-p) sessions record no origin; only a non-human origin disqualifies.
    && (!o.origin || o.origin.kind === 'human')
    && !o.isMeta
    && typeof o.message?.content === 'string'
    && o.message.content.trim().length > 0
  );
}

function parseTranscript(filePath, opts = {}) {
  if (!fs.existsSync(filePath)) return [];
  let lines = fs.readFileSync(filePath, 'utf8').split('\n');

  // Reading only the tail is enough to recover the most recent turns, and
  // keeps Stop-phase cost flat as a long session's transcript grows.
  if (opts.tailLines && lines.length > opts.tailLines) {
    lines = lines.slice(-opts.tailLines);
  }

  const turns = [];
  let current = null;

  for (const line of lines) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }

    if (isHumanPrompt(o)) {
      current = {
        promptId: o.promptId || `t${turns.length}`,
        prompt: o.message.content.trim(),
        timestamp: o.timestamp || null,
        tools: {},
        fileSet: new Set(),
        edits: 0,
        commands: 0,
        reads: 0,
      };
      turns.push(current);
      continue;
    }

    if (o.type !== 'assistant' || !current) continue;
    const content = o.message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!block || block.type !== 'tool_use') continue;
      const name = block.name || 'unknown';
      current.tools[name] = (current.tools[name] || 0) + 1;

      const kind = classifyTool(name);
      if (kind === 'edit') {
        current.edits++;
        const fp = block.input && block.input.file_path;
        if (fp) current.fileSet.add(fp);
      } else if (kind === 'command') {
        current.commands++;
      } else if (kind === 'read') {
        current.reads++;
      }
    }
  }

  return turns.map((t) => ({
    promptId: t.promptId,
    prompt: t.prompt,
    timestamp: t.timestamp,
    tools: t.tools,
    edits: t.edits,
    commands: t.commands,
    reads: t.reads,
    files: [...t.fileSet],
    distinctFiles: t.fileSet.size,
  }));
}

function findTranscripts(projectsDir = PROJECTS_DIR) {
  if (!fs.existsSync(projectsDir)) return [];
  const out = [];
  for (const dir of fs.readdirSync(projectsDir)) {
    const full = path.join(projectsDir, dir);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    for (const f of fs.readdirSync(full)) {
      if (f.endsWith('.jsonl')) out.push(path.join(full, f));
    }
  }
  return out;
}

/**
 * The most recent complete turn, derived from the transcript itself.
 *
 * This replaces counting tool calls live in a PostToolUse hook: that spawned
 * one node process per tool call (~166ms each, measured), while the transcript
 * already records the same facts for free.
 */
function lastTurn(filePath, opts = {}) {
  const turns = parseTranscript(filePath, { tailLines: opts.tailLines ?? 2000 });
  return turns.length ? turns[turns.length - 1] : null;
}

/**
 * Context size of the most recent request, from the usage Claude Code records on
 * each assistant message: fresh input + cache writes + cache reads. Reads only the
 * tail of the file — transcripts run to many megabytes and this runs on every prompt.
 */
function lastContextUsage(filePath, tailBytes = 512000) {
  const lines = readTailLines(filePath, tailBytes);
  if (!lines) return null;
  for (let i = lines.length - 1; i >= 0; i--) {
    // Usage recorded before a compaction describes context that no longer exists.
    if (lines[i].includes('"compact_boundary"') && isCompactBoundary(lines[i])) return { tokens: 0, model: null };
    if (!lines[i].includes('"usage"')) continue;
    let o;
    try {
      o = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const u = o && o.type === 'assistant' && o.message && o.message.usage;
    if (!u) continue;
    return { tokens: usageTokens(u), model: o.message.model || null };
  }
  return null;
}

function readTailLines(filePath, tailBytes) {
  let fd;
  try {
    const size = fs.statSync(filePath).size;
    const len = Math.min(size, tailBytes);
    const buf = Buffer.alloc(len);
    fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    if (len < size) lines.shift(); // the first line is probably cut mid-record
    return lines.filter(Boolean);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function isCompactBoundary(line) {
  try {
    const o = JSON.parse(line);
    return Boolean(o && o.type === 'system' && o.subtype === 'compact_boundary');
  } catch {
    return false;
  }
}

function usageTokens(u) {
  return (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
}

const COMMITTED = /\bgit\b[^\n|;&]*\b(commit|push)\b/;

/**
 * What the transcript tail says about the session right now: context size, model,
 * and where the last completed turn left the work.
 *
 *   boundary - it committed or pushed, or answered without editing or much digging
 *   working  - it edited files and did not commit
 *   unknown  - anything else, or no completed turn in the tail
 *
 * The prompt being submitted may already be written to the transcript, so a last
 * turn whose prompt matches `currentPrompt` is skipped in favour of the one before.
 */
function recentActivity(filePath, opts = {}) {
  const lines = readTailLines(filePath, opts.tailBytes ?? 512000);
  if (!lines) return null;

  let usage = { tokens: 0, model: null };
  const turns = [];
  let cur = null;
  let lastAgentAt = 0;

  for (const line of lines) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (isHumanPrompt(o)) {
      cur = { prompt: o.message.content.trim(), edits: 0, commands: 0, reads: 0, files: new Set(), committed: false };
      turns.push(cur);
      continue;
    }
    if (o && o.type === 'system' && o.subtype === 'compact_boundary') {
      usage = { tokens: 0, model: usage.model };
      continue;
    }
    if (!o || o.type !== 'assistant' || !o.message) continue;
    if (o.message.usage) usage = { tokens: usageTokens(o.message.usage), model: o.message.model || null };
    if (!cur || !Array.isArray(o.message.content)) continue;

    for (const block of o.message.content) {
      if (!block || block.type !== 'tool_use') continue;
      if (block.name === 'Agent' || block.name === 'Task') lastAgentAt = Date.parse(o.timestamp) || lastAgentAt;
      const kind = classifyTool(block.name || '');
      if (kind === 'edit') {
        cur.edits++;
        if (block.input && block.input.file_path) cur.files.add(block.input.file_path);
      } else if (kind === 'read') cur.reads++;
      else if (kind === 'command') {
        cur.commands++;
        if (COMMITTED.test(String((block.input && block.input.command) || ''))) cur.committed = true;
      }
    }
  }

  const current = String(opts.currentPrompt || '').trim();
  const completed = turns.length && current && turns[turns.length - 1].prompt === current
    ? turns.slice(0, -1)
    : turns;
  const last = completed[completed.length - 1] || null;

  let phase = 'unknown';
  if (last) {
    if (last.committed || (last.edits === 0 && last.commands <= 3)) phase = 'boundary';
    else if (last.edits > 0) phase = 'working';
  }

  // Completed turns in the tail, shaped for actualTier, so a caller can judge what
  // the session has really been doing rather than what its prompts said.
  const recent = completed.slice(-8).map((t) => ({
    edits: t.edits, commands: t.commands, reads: t.reads, distinctFiles: t.files.size,
  }));
  return { ...usage, phase, recent, lastAgentAt };
}

module.exports = {
  parseTranscript,
  lastTurn,
  lastContextUsage,
  recentActivity,
  readTailLines,
  findTranscripts,
  isHumanPrompt,
  PROJECTS_DIR,
};
