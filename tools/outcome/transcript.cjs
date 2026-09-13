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
    && o.origin
    && o.origin.kind === 'human'
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
  let fd;
  try {
    const size = fs.statSync(filePath).size;
    const len = Math.min(size, tailBytes);
    const buf = Buffer.alloc(len);
    fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buf, 0, len, size - len);

    const lines = buf.toString('utf8').split('\n');
    if (len < size) lines.shift(); // the first line is probably cut mid-record

    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"usage"')) continue;
      let o;
      try {
        o = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      const u = o && o.type === 'assistant' && o.message && o.message.usage;
      if (!u) continue;
      const tokens = (u.input_tokens || 0)
        + (u.cache_creation_input_tokens || 0)
        + (u.cache_read_input_tokens || 0);
      return { tokens, model: o.message.model || null };
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

module.exports = {
  parseTranscript, lastTurn, lastContextUsage, findTranscripts, isHumanPrompt, PROJECTS_DIR,
};
