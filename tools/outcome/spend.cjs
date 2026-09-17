'use strict';

const fs = require('fs');
const path = require('path');
const cost = require('../model-router/cost.cjs');
const { findTranscripts, PROJECTS_DIR } = require('./transcript.cjs');

/**
 * Where a session's money actually went, from the usage Claude Code records.
 *
 * Two views. Spend: every request priced as cache reads, cache writes, fresh input
 * and output, with each rewrite of already-cached context given its cause. Content:
 * every piece of context priced for its whole life, because a tool result added
 * early is re-read by every later request until compaction.
 */

const REWRITE_MIN_TOKENS = 30000;
const LARGE_OUTPUT_CHARS = 12000;
const GUARD_BUDGET_USD = require('../config.cjs').DEFAULTS.cacheGuard.budgetUsd;
const { RELIABLE_1H_MS } = require('../cache-guard.cjs');
const MODEL_COMMAND = '<command-name>/model</command-name>';
const IDLE_CAUSES = new Set(['expired', 'lateInHour']);

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
  const bucket = () => ({ n: 0, usd: 0 });
  return {
    sessions: 0,
    requests: 0,
    usd: { read: 0, write: 0, fresh: 0, out: 0 },
    rewrites: {
      expired: bucket(),
      lateInHour: bucket(),
      effortChange: bucket(),
      modelCommand: bucket(),
      modelSwitch: bucket(),
      compaction: bucket(),
      other: bucket(),
    },
    content: {},
    largeOutputs: { n: 0, tokens: 0 },
    // Idle rewrites costing clearly more than a fresh session: what /compact or /clear
    // before stepping away would have saved.
    avoidable: bucket(),
  };
}

/**
 * Each distinct request in order, and every rewrite of context the previous request
 * had already cached, with its cause:
 *
 *   compaction    a compact boundary came between (expected)
 *   modelSwitch   the model changed
 *   modelCommand  a /model command re-selected the same model
 *   expired       idle past the cache lifetime
 *   effortChange  the effort level changed, which invalidates cached messages
 *   lateInHour    idle 30-60 minutes on a nominal 1-hour cache
 *   other         nothing recorded locally explains it
 *
 * New content (one huge tool result, say) is written for the first time either way,
 * so only the part of a write that the previous request had cached counts.
 */
function walkRequests(records) {
  const seen = new Set();
  const requests = [];
  const boundaries = [];
  const rewrites = [];
  let prev = null;
  let compacted = false;
  let modelCommand = false;

  records.forEach((r, i) => {
    if (r && r.type === 'system' && r.subtype === 'compact_boundary') {
      boundaries.push(i);
      compacted = true;
      return;
    }
    const said = r && r.type === 'user' && r.message && r.message.content;
    if (typeof said === 'string' && said.includes(MODEL_COMMAND)) modelCommand = true;
    const u = r && r.type === 'assistant' && r.message && r.message.usage;
    if (!u) return;
    const id = r.requestId || r.message.id || `line-${i}`;
    if (seen.has(id)) return;
    seen.add(id);
    const p = cost.rate(r.message.model);
    if (!p) return;

    const created = u.cache_creation_input_tokens || 0;
    const oneHour = Math.min(created, (u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens) || 0);
    const writeUsd = ((created - oneHour) * p.in * cost.CACHE_WRITE_5M + oneHour * p.in * cost.CACHE_WRITE_1H) / 1e6;
    requests.push({ i, model: r.message.model, usage: u, rate: p, writeUsd });

    const at = Date.parse(r.timestamp) || 0;
    const context = created + (u.cache_read_input_tokens || 0) + (u.input_tokens || 0);
    const rewritten = prev ? created - Math.max(0, context - prev.context) : 0;
    if (prev && rewritten >= REWRITE_MIN_TOKENS) {
      const idleMs = at && prev.at ? at - prev.at : 0;
      let cause = 'other';
      if (compacted) cause = 'compaction';
      else if (cost.normalizeModel(prev.model) !== cost.normalizeModel(r.message.model)) cause = 'modelSwitch';
      else if (modelCommand) cause = 'modelCommand';
      // Expiry alone forces a rewrite, so it outranks an effort change made while idle.
      else if (idleMs >= (prev.oneHour ? 3600000 : 300000)) cause = 'expired';
      else if (prev.effort && r.effort && prev.effort !== r.effort) cause = 'effortChange';
      else if (prev.oneHour && idleMs >= RELIABLE_1H_MS) cause = 'lateInHour';
      rewrites.push({
        cause,
        at,
        idleMs,
        tokens: rewritten,
        usd: (writeUsd * rewritten) / created,
        freshUsd: (cost.FRESH_SESSION_TOKENS * p.in * (prev.oneHour ? cost.CACHE_WRITE_1H : cost.CACHE_WRITE_5M)) / 1e6,
        fromEffort: prev.effort,
        toEffort: r.effort,
      });
    }
    // The cache lifetime is known from the last request that wrote one.
    prev = {
      at,
      model: r.message.model,
      effort: r.effort,
      oneHour: created ? oneHour > 0 : Boolean(prev && prev.oneHour),
      context,
    };
    compacted = false;
    modelCommand = false;
  });
  return { requests, boundaries, rewrites };
}

/** The rewrites alone, for the per-prompt hook. */
function classifyRewrites(records) {
  return walkRequests(records).rewrites;
}

/** Fold one transcript's records into the report. */
function analyzeRecords(records, report = newReport()) {
  const { requests, boundaries, rewrites } = walkRequests(records);
  if (!requests.length) return report;
  report.sessions++;

  for (const q of requests) {
    const u = q.usage;
    report.requests++;
    report.usd.read += ((u.cache_read_input_tokens || 0) * cost.cacheReadRate(q.model)) / 1e6;
    report.usd.write += q.writeUsd;
    report.usd.fresh += ((u.input_tokens || 0) * q.rate.in) / 1e6;
    report.usd.out += ((u.output_tokens || 0) * q.rate.out) / 1e6;
  }
  for (const ev of rewrites) {
    report.rewrites[ev.cause].n++;
    report.rewrites[ev.cause].usd += ev.usd;
    if (IDLE_CAUSES.has(ev.cause) && ev.usd - ev.freshUsd >= GUARD_BUDGET_USD) {
      report.avoidable.n++;
      report.avoidable.usd += ev.usd - ev.freshUsd;
    }
  }

  // Lifetime cost: each item is re-read by every later request until the next compaction.
  const readRate = cost.cacheReadRate(requests[requests.length - 1].model) || 0;
  const rereads = (i) => {
    const end = boundaries.find((b) => b > i) ?? Infinity;
    let n = 0;
    for (const q of requests) if (q.i > i && q.i < end) n++;
    return n;
  };
  const tool = {};
  records.forEach((r, i) => {
    const content = r && r.message && r.message.content;
    const add = (kind, text) => {
      const t = approxTokens(text);
      if (!t) return;
      const c = (report.content[kind] ||= { n: 0, tokens: 0, usd: 0 });
      c.n++;
      c.tokens += t;
      c.usd += (t * rereads(i) * readRate) / 1e6;
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
    'rewrites of already-cached context, by cause:',
  ];
  const why = {
    expired: 'cache expired while idle',
    lateInHour: 'idle 30-60 min, where a 1-hour cache is unreliable',
    effortChange: 'effort level changed',
    modelCommand: '/model re-selected the model in use (now asks first)',
    modelSwitch: 'model switched (Claude Code confirms these)',
    compaction: 'context compacted (expected)',
    other: 'no local cause (dropped on the API side)',
  };
  for (const [key, v] of Object.entries(report.rewrites)) {
    lines.push(`  ${String(v.n).padStart(4)}  ${money(v.usd).padStart(9)}  ${pct(v.usd).padStart(6)}  ${why[key]}`);
  }
  if (report.avoidable.n) {
    lines.push(`  ${report.avoidable.n} idle rewrites cost $${GUARD_BUDGET_USD.toFixed(2)}+ over a fresh session: /compact or /clear ` +
      `before stepping away saves ${money(report.avoidable.usd)} (${pct(report.avoidable.usd)})`);
  }
  lines.push('', 'context by lifetime re-read cost (what it cost to keep it in context):');
  Object.entries(report.content)
    .sort((a, b) => b[1].usd - a[1].usd)
    .slice(0, top)
    .forEach(([key, c]) => lines.push(`  ${key.padEnd(34)} ${String(c.n).padStart(6)}x ${String(c.tokens).padStart(9)} tok  ${money(c.usd)}`));
  if (report.largeOutputs.n) {
    lines.push('', `${report.largeOutputs.n} shell outputs over ${LARGE_OUTPUT_CHARS} chars (${report.largeOutputs.tokens} tokens): ` +
      'pipe noisy commands through tail or grep.');
  }
  return lines.join('\n');
}

const INSTALL = [
  'claude plugin marketplace add RiyanKothari/riyans-claude-skills',
  'claude plugin install rcskills@riyans-claude-skills',
];

/**
 * The part a first-time reader needs: what went where, and what was avoidable, in
 * words. Prices are API list prices; on a Pro or Max plan the same tokens come out
 * of usage limits instead of a bill.
 *
 * @param {ReturnType<typeof newReport>} report
 * @param {{invite?: boolean}} [opts]
 */
function formatSummary(report, opts = {}) {
  const u = report.usd;
  const total = u.read + u.write + u.fresh + u.out;
  const money = (x) => `$${x.toFixed(2)}`;
  const share = (x) => (total ? `${((x / total) * 100).toFixed(1)}%` : '0%');
  const lines = [
    'Claude Code spend, read from your local transcripts. Nothing is sent anywhere.',
    '',
    `  ${report.sessions} sessions, ${report.requests} requests: ${money(total)} at API list price`,
    `  ${share(u.read)} went on re-reading context Claude already had cached.`,
  ];
  if (report.avoidable.n) {
    lines.push(
      `  ${money(report.avoidable.usd)} (${share(report.avoidable.usd)}) re-sent a whole cached session after a break, ${report.avoidable.n} times.`,
      '  Running /compact or /clear before stepping away would have saved that.',
    );
  } else {
    lines.push('  No break re-sent a large cached session: nothing avoidable there.');
  }
  lines.push('  On a Pro or Max plan these are usage limits rather than dollars.');
  if (opts.invite) {
    lines.push('', 'To be told before it happens, in Claude Code:', ...INSTALL.map((c) => `  ${c}`));
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
    console.log(`No Claude Code transcripts found in ${PROJECTS_DIR}${filter ? ` for ${filter}` : ''}.`);
    console.log('If Claude Code keeps its config elsewhere, set CLAUDE_CONFIG_DIR to that folder.');
  } else {
    if (process.stderr.isTTY && !args.includes('--json')) process.stderr.write(`Reading ${files.length} transcripts...\n`);
    const report = analyzeFiles(files);
    if (args.includes('--json')) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      // npx sets npm_command=exec: someone trying this before installing anything.
      console.log(formatSummary(report, { invite: process.env.npm_command === 'exec' }));
      console.log(`\nDetail\n\n${formatReport(report)}`);
    }
  }
}

module.exports = { analyzeRecords, analyzeFiles, classifyRewrites, formatReport, formatSummary, newReport, REWRITE_MIN_TOKENS };
