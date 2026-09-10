'use strict';

const fs = require('fs');
const path = require('path');

// Thresholds adapted from ECC's context-budget skill. Each marks the point
// where a component stops paying for the context it occupies.
const LIMITS = {
  agentLines: 200,
  skillLines: 400,
  ruleLines: 100,
  claudeMdLines: 300,
  descriptionWords: 30,
  mcpServers: 10,
  mcpToolsPerServer: 20,
};

// An MCP tool's schema costs roughly this much in every single request.
const TOKENS_PER_MCP_TOOL = 500;

const CODE_EXT = new Set(['.js', '.cjs', '.mjs', '.ts', '.json', '.py', '.go', '.rs', '.sh']);

/** Prose and code tokenize at very different rates; one formula for both lies. */
function estimateTokens(text, isCode) {
  const s = String(text ?? '');
  if (isCode) return Math.ceil(s.length / 4);
  const words = s.split(/\s+/).filter(Boolean).length;
  return Math.ceil(words * 1.3);
}

function fileFacts(file) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const isCode = CODE_EXT.has(path.extname(file));
  return {
    path: file,
    name: path.basename(path.dirname(file)) || path.basename(file),
    lines: text.split('\n').length,
    tokens: estimateTokens(text, isCode),
    description: extractDescription(text),
  };
}

function extractDescription(text) {
  const m = text.match(/^---[\s\S]*?^description:\s*(.+?)$/m);
  return m ? m[1].trim() : null;
}

function listComponents(dir, kind) {
  const out = [];
  if (!fs.existsSync(dir)) return out;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const candidate of ['SKILL.md', 'AGENT.md', 'index.md']) {
        const f = path.join(full, candidate);
        if (fs.existsSync(f)) {
          const facts = fileFacts(f);
          if (facts) out.push({ ...facts, kind, name: entry.name });
          break;
        }
      }
    } else if (entry.name.endsWith('.md')) {
      const facts = fileFacts(full);
      if (facts) out.push({ ...facts, kind, name: entry.name.replace(/\.md$/, '') });
    }
  }
  return out;
}

function auditMcp(file) {
  if (!fs.existsSync(file)) return { servers: [], totalTokens: 0 };
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return { servers: [], totalTokens: 0, unreadable: true };
  }

  const servers = Object.keys(cfg.mcpServers || {}).map((name) => ({
    name,
    // Tool count is only knowable at runtime, so this is a floor, flagged as
    // an estimate rather than presented as measured.
    estimatedTokens: TOKENS_PER_MCP_TOOL * 10,
  }));

  return {
    servers,
    totalTokens: servers.reduce((a, s) => a + s.estimatedTokens, 0),
    estimated: true,
  };
}

function flagsFor(c) {
  const flags = [];
  const limit = c.kind === 'agent' ? LIMITS.agentLines
    : c.kind === 'skill' ? LIMITS.skillLines
      : LIMITS.ruleLines;

  if (c.lines > limit) flags.push(`${c.lines} lines (limit ${limit})`);
  if (c.description) {
    const words = c.description.split(/\s+/).filter(Boolean).length;
    if (words > LIMITS.descriptionWords) flags.push(`${words}-word description`);
  }
  return flags;
}

function audit(opts = {}) {
  const root = opts.dir || path.join(process.cwd(), '.claude');

  const components = [
    ...listComponents(path.join(root, 'skills'), 'skill'),
    ...listComponents(path.join(root, 'agents'), 'agent'),
    ...listComponents(path.join(root, 'commands'), 'command'),
  ].map((c) => ({ ...c, flags: flagsFor(c) }));

  const claudeMd = [];
  for (const p of [path.join(path.dirname(root), 'CLAUDE.md'), path.join(root, 'CLAUDE.md')]) {
    const f = fileFacts(p);
    if (f) claudeMd.push({ ...f, kind: 'claude.md' });
  }

  const mcp = auditMcp(opts.mcpFile || path.join(path.dirname(root), '.mcp.json'));

  const componentTokens = components.reduce((a, c) => a + c.tokens, 0);
  const claudeMdTokens = claudeMd.reduce((a, c) => a + c.tokens, 0);
  const claudeMdLines = claudeMd.reduce((a, c) => a + c.lines, 0);

  const warnings = [];
  if (mcp.servers.length >= LIMITS.mcpServers) {
    warnings.push(`${mcp.servers.length} MCP servers active (limit ${LIMITS.mcpServers})`);
  }
  if (claudeMdLines > LIMITS.claudeMdLines) {
    warnings.push(`CLAUDE.md totals ${claudeMdLines} lines (limit ${LIMITS.claudeMdLines})`);
  }

  // Ranked by leverage: MCP schemas are paid on every request, so they sit
  // above even the heaviest skill file.
  const offenders = [...components]
    .filter((c) => c.flags.length)
    .sort((a, b) => b.tokens - a.tokens);

  return {
    root,
    components,
    offenders,
    claudeMd,
    mcp,
    warnings,
    totals: {
      componentCount: components.length,
      componentTokens,
      claudeMdTokens,
      mcpTokens: mcp.totalTokens,
      alwaysLoaded: claudeMdTokens + mcp.totalTokens,
      grand: componentTokens + claudeMdTokens + mcp.totalTokens,
    },
  };
}

function formatReport(r) {
  const L = [];
  const k = (n) => `${(n / 1000).toFixed(1)}k`;

  L.push(`# context audit — ${r.root}`);
  L.push('');
  L.push(`always loaded:   ${k(r.totals.alwaysLoaded)} tokens (CLAUDE.md + MCP schemas)`);
  L.push(`on-demand pool:  ${k(r.totals.componentTokens)} tokens across ${r.totals.componentCount} components`);
  L.push(`worst case:      ${k(r.totals.grand)} tokens if everything loads`);
  L.push('');

  if (r.mcp.servers.length) {
    L.push(`## MCP (${r.mcp.servers.length} servers, ~${k(r.mcp.totalTokens)} tokens, estimated)`);
    L.push('Highest leverage: an unused server costs its full schema on every request.');
    for (const s of r.mcp.servers) L.push(`  ${s.name}`);
    L.push('');
  }

  if (r.offenders.length) {
    L.push(`## oversized components (${r.offenders.length})`);
    for (const o of r.offenders.slice(0, 12)) {
      L.push(`  ${String(o.tokens).padStart(6)} tok  ${o.kind.padEnd(8)} ${o.name} — ${o.flags.join(', ')}`);
    }
    L.push('');
  }

  if (r.warnings.length) {
    L.push('## warnings');
    for (const w of r.warnings) L.push(`  ${w}`);
    L.push('');
  }

  L.push('## where the leverage is');
  L.push('  1. MCP servers  — remove unused ones first, schemas load every request');
  L.push('  2. CLAUDE.md    — always loaded, so every line is paid every turn');
  L.push('  3. heavy skills — move detail into references/ and load on demand');

  return L.join('\n');
}

module.exports = { audit, formatReport, estimateTokens, LIMITS, TOKENS_PER_MCP_TOOL };
