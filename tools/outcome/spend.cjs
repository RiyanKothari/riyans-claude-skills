'use strict';

const fs = require('fs');
const path = require('path');
const cost = require('../model-router/cost.cjs');
const { findTranscripts } = require('./transcript.cjs');

/**
 * Where a session's money actually went, from the usage Claude Code records.
 *
 * Two views. Spend: every request priced as cache reads, cache writes, fresh input
 * and output, with each large mid-session cache write explained (the cache expired,
 * the model switched, the context was compacted, or something else changed the
 * prefix). Content: every piece of context priced for its whole life, because a
 * tool result added early is re-read by every later request until compaction.
 */

const REWRITE_MIN_TOKENS = 30000;
const LARGE_OUTPUT_CHARS = 12000;
const GUARD_BUDGET_USD = require('../config.cjs').DEFAULTS.cacheGuard.budgetUsd;
const { RELIABLE_1H_MS } = require('../cache-guard.cjs');
const MODEL_COMMAND = '<command-name>/model</command-name>';

const approxTokens = (s) => Math.ceil(String(s || '').length / 4);

function blockText(c) {
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.map((b) => (b && (b.text || (b.content && blockText(b.content)))) || '').join('');
}

function readRecords(file) {
  const out = [];
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line.replace(/^﻿/, '')));
    } catch {
      // A torn final line is normal while a session is running.
    }
  }
  return out;
}

function newReport() {
  return {
    sessions: 0,
    requests: 0,
    usd: { read: 0, write: 0, fresh: 0, out: 0 },
    rewrites: {
      expired: { n: 0, usd: 0 },
      lateInHour: { n: 0, usd: 0 },
      modelCommand: { n: 0, usd: 0 },
      modelSwitch: { n: 0, usd: 0 },
      compaction: { n: 0, usd: 0 },
      other: { n: 0, usd: 0 },
    },
    content: {},
    largeOutputs: { n: 0, tokens: 0 },
    // Idle rewrites costing clearly more than a fresh session: what /compact or /clear
    // before stepping away would have saved.
    avoidable: { n: 0, usd: 0 },
  };
}

function addContent(report, kind, tokens, usd) {
  const c = (report.content[kind] ||= { n: 0, tokens: 0, usd: 0 });
  c.n++;
  c.tokens += tokens;
  c.usd += usd;
}

/** Fold one transcript's records into the report. */
function analyzeRecords(records, report = newReport()) {
  const seen = new Set();
  const requests = []; // record index of each distinct request
  const boundaries = [];
  let prev = null;
  let compactedSincePrev = false;
  let modelCommandSincePrev = false;

  records.forEach((r, i) => {
    if (r && r.type === 'system' && r.subtype === 'compact_boundary') {
      boundaries.push(i);
      compactedSincePrev = true;
      return;
    }
    const said = r && r.type === 'user' && r.message && r.message.content;
    if (typeof said === 'string' && said.includes(MODEL_COMMAND)) modelCommandSincePrev = true;
    const u = r && r.type === 'assistant' && r.message && r.message.usage;
    if (!u) return;
    const id = r.requestId || r.message.id || `line-${i}`;
    if (seen.has(id)) return;
    seen.add(id);
    const p = cost.rate(r.message.model);
    if (!p) return;

    requests.push(i);
    report.requests++;
    const created = u.cache_creation_input_tokens || 0;
    const oneHour = Math.min(created, (u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens) || 0);
    const writeUsd = ((created - oneHour) * p.in * cost.CACHE_WRITE_5M + oneHour * p.in * cost.CACHE_WRITE_1H) / 1e6;
    report.usd.read += ((u.cache_read_input_tokens || 0) * cost.cacheReadRate(r.message.model)) / 1e6;
    report.usd.write += writeUsd;
    report.usd.fresh += ((u.input_tokens || 0) * p.in) / 1e6;
    report.usd.out += ((u.output_tokens || 0) * p.out) / 1e6;

    const at = Date.parse(r.timestamp) || 0;
    const context = created + (u.cache_read_input_tokens || 0) + (u.input_tokens || 0);
    // Only context the previous request had already cached counts as rewritten; new
    // content (one huge tool result, say) is written for the first time either way.
    const rewritten = prev ? created - Math.max(0, context - prev.context) : 0;
    if (prev && rewritten >= REWRITE_MIN_TOKENS) {
      const share = rewritten / created;
      const ttlMs = prev.oneHour ? 3600000 : 300000;
      const idle = at && prev.at ? at - prev.at : 0;
      let cause = 'other';
      if (compactedSincePrev) cause = 'compaction';
      else if (cost.normalizeModel(prev.model) !== cost.normalizeModel(r.message.model)) cause = 'modelSwitch';
      else if (modelCommandSincePrev) cause = 'modelCommand';
      else if (idle >= ttlMs) cause = 'expired';
      else if (prev.oneHour && idle >= RELIABLE_1H_MS) cause = 'lateInHour';
      report.rewrites[cause].n++;
      report.rewrites[cause].usd += writeUsd * share;
      if (cause === 'expired' || cause === 'lateInHour') {
        const fresh = (cost.FRESH_SESSION_TOKENS * p.in * (prev.oneHour ? cost.CACHE_WRITE_1H : cost.CACHE_WRITE_5M)) / 1e6;
        if (writeUsd * share - fresh >= GUARD_BUDGET_USD) {
          report.avoidable.n++;
          report.avoidable.usd += writeUsd * share - fresh;
        }
      }
    }
    // The cache lifetime is known from the last request that wrote one.
    prev = { at, model: r.message.model, oneHour: created ? oneHour > 0 : Boolean(prev && prev.oneHour), context };
    compactedSincePrev = false;
    modelCommandSincePrev = false;
  });
  if (!requests.length) return report;
  report.sessions++;

  // Lifetime cost: each item is re-read by every later request until the next compaction.
  const model = records[requests[requests.length - 1]].message.model;
  const readRate = cost.cacheReadRate(model) || 0;
  const rereads = (i) => {
    const end = boundaries.find((b) => b > i) ?? Infinity;
    let n = 0;
    for (const q of requests) if (q > i && q < end) n++;
    return n;
  };
  const tool = {};
  records.forEach((r, i) => {
    const content = r && r.message && r.message.content;
    const add = (kind, text) => {
      const t = approxTokens(text);
      if (t) addContent(report, kind, t, (t * rereads(i) * readRate) / 1e6);
    };
    if (r && r.type === 'assistant' && Array.isArray(content)) {
      for (const b of content) {
        if (b.type === 'tool_use') {
          tool[b.id] = b.name;
          add(`call:${b.name}`, JSON.stringify(b.input || {}));
        } else if (b.type === 'text') add('reply', b.text);
      }
    } else if (r && r.type === 'user' && Array.isArray(content)) {
      for (const b of content) {
        if (b.type === 'tool_result') {
          const text = blockText(b.content);
          const name = tool[b.tool_use_id] || 'unknown';
          add(`result:${name}`, text);
          if (/^(Bash|PowerShell)$/.test(name) && text.length > LARGE_OUTPUT_CHARS) {
            report.largeOutputs.n++;
            report.largeOutputs.tokens += approxTokens(text);
          }
        } else if (b.type === 'text') add(r.isMeta ? 'skill/meta' : 'prompt', b.text);
      }
    } else if (r && r.type === 'user' && typeof content === 'string') {
      add(r.isMeta ? 'skill/meta' : 'prompt', content);
    } else if (r && r.type === 'attachment' && r.rendered) {
      // Only rendered attachments reach the model.
      const a = r.attachment || {};
      const kind = /hook/.test(a.type || '') ? `hook:${a.hookEvent || a.hookName || a.type}` : `attachment:${a.type}`;
      add(kind, JSON.stringify(r.rendered));
    }
  });
  return report;
}

function analyzeFiles(files) {
  const report = newReport();
  for (const f of files) analyzeRecords(readRecords(f), report);
  return report;
}

function formatReport(report, top = 12) {
  const u = report.usd;
  const total = u.read + u.write + u.fresh + u.out;
  const pct = (x) => (total ? `${((x / total) * 100).toFixed(1)}%` : '0%');
  const money = (x) => `$${x.toFixed(2)}`;
  const lines = [
    `${report.sessions} session file(s), ${report.requests} requests, ${money(total)} at list price`,
    `  cache reads   ${money(u.read).padStart(9)}  ${pct(u.read)}`,
    `  cache writes  ${money(u.write).padStart(9)}  ${pct(u.write)}`,
    `  output        ${money(u.out).padStart(9)}  ${pct(u.out)}`,
    `  fresh input   ${money(u.fresh).padStart(9)}  ${pct(u.fresh)}`,
    '',
    'large mid-session cache rewrites:',
  ];
  const why = {
    expired: 'cache expired while idle (after-reply notice)',
    lateInHour: 'idle 30-60 min, where a 1-hour cache is unreliable (after-reply notice)',
    modelCommand: '/model re-selected the model in use (now asks first)',
    modelSwitch: 'model switched (Claude Code confirms these)',
    compaction: 'context compacted (expected, and small)',
    other: 'no local cause found',
  };
  for (const [k, v] of Object.entries(report.rewrites)) {
    lines.push(`  ${String(v.n).padStart(4)}  ${money(v.usd).padStart(9)}  ${pct(v.usd).padStart(6)}  ${why[k]}`);
  }
  if (report.avoidable.n) {
    lines.push(`  ${report.avoidable.n} idle rewrites cost $${GUARD_BUDGET_USD.toFixed(2)}+ over a fresh session: /compact or /clear ` +
      `before stepping away saves ${money(report.avoidable.usd)} (${pct(report.avoidable.usd)})`);
  }
  lines.push('', 'context by lifetime re-read cost (what it cost to keep it in context):');
  Object.entries(report.content)
    .sort((a, b) => b[1].usd - a[1].usd)
    .slice(0, top)
    .forEach(([k, c]) => lines.push(`  ${k.padEnd(34)} ${String(c.n).padStart(6)}x ${String(c.tokens).padStart(9)} tok  ${money(c.usd)}`));
  if (report.largeOutputs.n) {
    lines.push('', `${report.largeOutputs.n} shell outputs over ${LARGE_OUTPUT_CHARS} chars (${report.largeOutputs.tokens} tokens): ` +
      'pipe noisy commands through tail or grep.');
  }
  return lines.join('\n');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--project');
  const filter = i >= 0 ? String(args[i + 1] || '') : '';
  const encoded = filter ? path.resolve(filter).replace(/[^A-Za-z0-9]/g, '-') : '';
  const files = findTranscripts().filter((f) => !encoded || f.includes(encoded));
  if (!files.length) {
    console.log('No transcripts found.');
  } else {
    const report = analyzeFiles(files);
    console.log(args.includes('--json') ? JSON.stringify(report, null, 2) : formatReport(report));
  }
}

module.exports = { analyzeRecords, analyzeFiles, formatReport, newReport, REWRITE_MIN_TOKENS };
