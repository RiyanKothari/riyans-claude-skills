#!/usr/bin/env node
'use strict';

/**
 * Closes the loop between routing and outcomes.
 *
 *   core     (SessionStart)     - fixed core memory, last-session handoff, compaction prompt
 *   recall   (UserPromptSubmit) - relevant memory, routing advice and compaction prompt
 *   finalize (Stop)             - score the turn from the transcript and store it as evidence
 *
 * Every mode must exit 0 and stay silent on failure: a hook that throws breaks
 * every prompt submission, and one that chatters costs more than it saves.
 *
 * `--global` marks an invocation from ~/.claude/settings.json. Tools always load
 * from this harness repo; project data goes under ~/.claude so prompts are never
 * written into another repo's working tree; and inside this repo the global copy
 * stands down, because the project settings already run the hook.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const HARNESS_ROOT = path.join(__dirname, '..', '..');
const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const GLOBAL = process.argv.includes('--global');

function samePath(a, b) {
  const norm = (p) => path.resolve(p);
  // Windows paths are case-insensitive, and CLAUDE_PROJECT_DIR's casing is not guaranteed.
  return process.platform === 'win32'
    ? norm(a).toLowerCase() === norm(b).toLowerCase()
    : norm(a) === norm(b);
}

function dataDir() {
  if (!GLOBAL) return path.join(ROOT, '.claude', 'memory');
  const key = path.resolve(ROOT).replace(/[:\\/]+/g, '-').replace(/^-+|-+$/g, '');
  return path.join(os.homedir(), '.claude', 'token-harness', 'projects', key);
}

const DATA = dataDir();
const STATE = path.join(DATA, 'turn-state.json');
const DB = process.env.SMART_MEMORY_PATH || path.join(DATA, 'records.jsonl');
const HANDOFF = path.join(DATA, 'handoff.json');
const COMPACT_STATE = path.join(DATA, 'compact-state.json');
// Pinned policy lives in the harness repo's own store and follows every project.
const HARNESS_DB = path.join(HARNESS_ROOT, '.claude', 'memory', 'records.jsonl');

const RECALL_BUDGET = Number(process.env.SMART_MEMORY_BUDGET || 350);
// The core is injected into every session unconditionally, so its ceiling is
// paid on every single session start. Keep it tighter than per-prompt recall.
const CORE_BUDGET = Number(process.env.SMART_MEMORY_CORE_BUDGET || 400);
const MAX_NEIGHBORS = 5;

function req(rel) {
  // Harness repo first, so the hook works in projects that have no tools/ of their own.
  for (const base of [HARNESS_ROOT, ROOT]) {
    try {
      return require(path.join(base, 'tools', rel));
    } catch {
      // Fall through to the next location.
    }
  }
  return null;
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function parseInput() {
  // Some shells prepend a UTF-8 BOM, which makes JSON.parse throw and would
  // silently degrade every field to undefined.
  const raw = readStdin().replace(/^﻿/, '').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
    if (typeof parsed === 'string') return { prompt: parsed };
    return {};
  } catch {
    return { prompt: raw };
  }
}

function readJsonFile(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonFile(p, value) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(value), 'utf8');
  } catch {
    // Bookkeeping is best-effort; losing it costs one reminder, not the session.
  }
}

function openStore(dbPath = DB) {
  const mod = req('memory/store.cjs');
  if (!mod) return null;
  try {
    return new mod.MemoryStore({ path: dbPath }).load();
  } catch {
    return null;
  }
}

// Past turns whose prompts resemble this one, with what they actually cost.
function findNeighbors(store, prompt, scoreMod) {
  if (!store || !scoreMod) return [];
  let ranked;
  try {
    ranked = store.score(prompt);
  } catch {
    return [];
  }
  const outcomes = ranked.filter((h) => h.rec.kind === 'outcome');
  if (!outcomes.length) return [];

  const top = outcomes.slice(0, MAX_NEIGHBORS);
  const max = top[0].score || 1;

  return top
    .map((h) => {
      const tierTag = (h.rec.tags || []).find((t) => scoreMod.TIERS.includes(t));
      if (!tierTag) return null;
      return {
        actualScore: scoreMod.TIER_SCORE[tierTag],
        similarity: Number((h.score / max).toFixed(3)),
        tier: tierTag,
      };
    })
    .filter(Boolean);
}

/** What one more request costs just to re-read the context, at cache-read rates. */
function requestCost(tokens, model) {
  const costMod = req('model-router/cost.cjs');
  const rate = costMod && model && costMod.PRICING[model];
  return rate ? (tokens / 1e6) * rate.in * costMod.CACHE_READ_MULTIPLIER : null;
}

/**
 * The compaction prompt, governed by `rcskills config compact ...`. Mid-session
 * this is the only way the user hears about context growth: SessionStart fires
 * once, but a long session keeps growing long after it.
 */
function compactPrompt(tokens, input, costs) {
  const compactMod = req('compact.cjs');
  const configMod = req('config.cjs');
  if (!compactMod || !configMod || !tokens) return null;

  const state = readJsonFile(COMPACT_STATE);
  const result = compactMod.adviseCompact({
    tokens,
    sessionId: input.session_id || null,
    state,
    settings: configMod.load().compact,
    costPerRequestUsd: costs.costPerRequestUsd || null,
    rewriteUsd: costs.rewriteUsd || null,
  });

  const next = result.state;
  if (!state || state.sessionId !== next.sessionId || state.advisedAt !== next.advisedAt) {
    writeJsonFile(COMPACT_STATE, next);
  }
  return result.message;
}

function modeRecall() {
  const input = parseInput();
  const prompt = String(input.prompt || '').trim();
  if (!prompt) process.exit(0);

  writeJsonFile(STATE, {
    prompt: prompt.slice(0, 500),
    promptId: input.prompt_id || input.promptId || null,
    startedAt: Date.now(),
  });

  const store = openStore();
  const scoreMod = req('outcome/score.cjs');
  const router = req('model-router/index.cjs');
  const out = [];

  const neighbors = findNeighbors(store, prompt, scoreMod);

  if (router) {
    try {
      const r = router.recommend(prompt, { repoRoot: ROOT, neighbors });
      if (r.delegate && r.savedPct >= 50) {
        const ev = neighbors.length >= 2 ? `, ${neighbors.length} past similar turns` : '';
        out.push(
          `[router] ${r.tier} (conf ${r.confidence}${ev}). Mechanical subtasks -> ` +
          `Agent tool model:"${r.agentModel}", ~${r.savedPct}% cheaper. Inline if it needs repo context.`,
        );
      }
    } catch {
      // Routing advice is optional; never block the prompt.
    }
  }

  if (store) {
    try {
      const rec = store.recall(prompt, { budgetTokens: RECALL_BUDGET, limit: 3 });
      const notes = rec.records.filter((r) => r.kind !== 'outcome');
      if (notes.length) {
        out.push(`[memory] ${notes.map((r) => r.text).join(' | ')}`);
      }
      store.save();
    } catch {
      // Recall is best-effort.
    }
  }

  const tsMod = req('outcome/transcript.cjs');
  const tPath = input.transcript_path || input.transcriptPath;
  const usage = tsMod && tPath ? tsMod.lastContextUsage(tPath) : null;
  if (usage) {
    const advice = compactPrompt(usage.tokens, input, {
      costPerRequestUsd: requestCost(usage.tokens, usage.model),
    });
    if (advice) out.push(advice);
  }

  if (out.length) process.stdout.write(`${out.join('\n')}\n`);
  process.exit(0);
}

function readScorecards() {
  try {
    return fs
      .readFileSync(path.join(DATA, 'scorecards.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Pinned and earned core records: this project's first, then the harness repo's. */
function coreTexts() {
  const stores = [openStore(DB)];
  if (!samePath(HARNESS_DB, DB)) stores.push(openStore(HARNESS_DB));

  const seen = new Set();
  const kept = [];
  let used = 0;
  for (const store of stores) {
    if (!store) continue;
    for (const r of store.coreRecords({ budgetTokens: CORE_BUDGET })) {
      if (seen.has(r.text) || used + r.tokens > CORE_BUDGET) continue;
      seen.add(r.text);
      used += r.tokens;
      kept.push(r.text);
    }
  }
  return kept;
}

/**
 * SessionStart. The fixed core: the same bounded block every new session gets,
 * regardless of what is asked. Pinned records are the standing policy that must
 * survive a model swap or a context reset.
 */
function modeCore() {
  const input = parseInput();
  const out = [];

  const core = coreTexts();
  if (core.length) out.push(`[core] ${core.join(' | ')}`);

  const h = readJsonFile(HANDOFF);
  if (h && h.summary) {
    const ago = h.at ? Math.round((Date.now() - h.at) / 3600000) : null;
    out.push(`[last session${ago !== null ? ` ${ago}h ago` : ''}] ${h.summary}`);
  }

  // Carrying the recurring weak spot into every session is what turns the
  // scorecard from a ritual into pressure to actually fix the habit.
  const sc = readScorecards();
  if (sc.length) {
    const last = sc[sc.length - 1];
    const counts = {};
    for (const r of sc) if (r.weakest) counts[r.weakest] = (counts[r.weakest] || 0) + 1;
    const [key, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] || [];
    const repeat = n > 1 ? ` recurring weak spot: ${key} (${n}x)` : '';
    out.push(`[scorecard] last ${last.total}/100, weakest ${last.weakest}.${repeat}`);
  }

  const advice = compactPrompt(Number(input.context_tokens || 0), input, {
    rewriteUsd: Number(input.estimated_cache_write_usd || 0) || null,
  });
  if (advice) out.push(advice);

  if (out.length) process.stdout.write(`${out.join('\n')}\n`);
  process.exit(0);
}

/**
 * Stop. Derives what the turn actually cost from the transcript rather than
 * counting live: a PostToolUse hook spawned one node process per tool call
 * (~166ms measured), while the transcript already holds the same facts.
 */
function modeFinalize() {
  const input = parseInput();
  const scoreMod = req('outcome/score.cjs');
  const tsMod = req('outcome/transcript.cjs');
  const store = openStore();
  if (!scoreMod || !tsMod || !store) process.exit(0);

  const tPath = input.transcript_path || input.transcriptPath;
  if (!tPath) process.exit(0);

  let turn;
  try {
    turn = tsMod.lastTurn(tPath);
  } catch {
    process.exit(0);
  }
  if (!turn || !turn.prompt) process.exit(0);

  const obs = {
    edits: turn.edits,
    commands: turn.commands,
    reads: turn.reads,
    distinctFiles: turn.distinctFiles,
  };

  // A turn that did nothing observable teaches nothing worth storing.
  if (obs.edits + obs.commands + obs.reads === 0) process.exit(0);

  try {
    const tier = scoreMod.actualTier(obs);
    store.add({
      kind: 'outcome',
      text: turn.prompt.slice(0, 300),
      tags: ['outcome', tier, `files:${obs.distinctFiles}`, `edits:${obs.edits}`],
    });
    store.prune();
    store.save();

    writeJsonFile(HANDOFF, {
      at: Date.now(),
      summary:
        `${tier} turn: ${obs.distinctFiles} file(s), ${obs.edits} edit(s), ` +
        `${obs.commands} command(s). "${turn.prompt.slice(0, 90)}"`,
    });
  } catch {
    // Never let bookkeeping fail a turn.
  }

  try { fs.unlinkSync(STATE); } catch {}
  process.exit(0);
}

// Inside the harness repo the project settings already run this hook; a global
// copy firing as well would double every outcome record.
if (GLOBAL && samePath(ROOT, HARNESS_ROOT)) process.exit(0);

const mode = process.argv[2];
if (mode === 'core') modeCore();
else if (mode === 'recall') modeRecall();
else if (mode === 'finalize') modeFinalize();
else process.exit(0);
