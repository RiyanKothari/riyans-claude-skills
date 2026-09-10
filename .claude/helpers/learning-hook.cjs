#!/usr/bin/env node
'use strict';

/**
 * Closes the loop between routing and outcomes.
 *
 *   recall   (UserPromptSubmit) - start a turn, surface memory + routing advice
 *   observe  (PostToolUse)      - count what the turn actually did
 *   finalize (Stop)             - score the turn and write it back as evidence
 *
 * Every mode must exit 0 and stay silent on failure: a hook that throws breaks
 * every prompt submission, and one that chatters costs more than it saves.
 */

const fs = require('fs');
const path = require('path');

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const STATE = path.join(ROOT, '.claude', 'memory', 'turn-state.json');
const DB = process.env.SMART_MEMORY_PATH
  || path.join(ROOT, '.claude', 'memory', 'records.jsonl');

const HANDOFF = path.join(ROOT, '.claude', 'memory', 'handoff.json');

const RECALL_BUDGET = Number(process.env.SMART_MEMORY_BUDGET || 350);
// The core is injected into every session unconditionally, so its ceiling is
// paid on every single session start. Keep it tighter than per-prompt recall.
const CORE_BUDGET = Number(process.env.SMART_MEMORY_CORE_BUDGET || 400);
const COMPACT_REMIND_EVERY = Number(process.env.SMART_COMPACT_REMIND || 60000);
const MAX_NEIGHBORS = 5;

function req(rel) {
  try {
    return require(path.join(ROOT, 'tools', rel));
  } catch {
    return null;
  }
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

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE, 'utf8'));
  } catch {
    return null;
  }
}

function saveState(s) {
  try {
    fs.mkdirSync(path.dirname(STATE), { recursive: true });
    fs.writeFileSync(STATE, JSON.stringify(s), 'utf8');
  } catch {
    // Losing turn state costs one learning sample, not the session.
  }
}

function openStore() {
  const mod = req('memory/store.cjs');
  if (!mod) return null;
  try {
    return new mod.MemoryStore({ path: DB }).load();
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

function modeRecall() {
  const input = parseInput();
  const prompt = String(input.prompt || '').trim();
  if (!prompt) process.exit(0);

  saveState({
    prompt: prompt.slice(0, 500),
    promptId: input.prompt_id || input.promptId || null,
    startedAt: Date.now(),
    edits: 0,
    commands: 0,
    reads: 0,
    files: [],
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

  if (out.length) process.stdout.write(`${out.join('\n')}\n`);
  process.exit(0);
}

/**
 * Compaction advice, scaled to the window rather than a flat number, and
 * re-issued only after real growth so it does not nag every session.
 *
 * Thresholds follow ECC's strategic-compact: 160k on a 200k window, 250k on 1M,
 * repeating every 60k of further growth.
 */
function compactAdvice(input, handoff) {
  const ctx = Number(input.context_tokens || 0);
  if (!ctx) return null;

  const window = ctx > 260000 ? 1000000 : 200000;
  const threshold = window >= 1000000 ? 250000 : 160000;
  if (ctx < threshold) return null;

  const lastAdvised = handoff && Number(handoff.compactAdvisedAt || 0);
  if (lastAdvised && ctx - lastAdvised < COMPACT_REMIND_EVERY) return null;

  const cacheUsd = Number(input.estimated_cache_write_usd || 0);
  const cost = cacheUsd ? ` (~$${cacheUsd.toFixed(2)} to rewrite cache)` : '';
  const pct = Math.round((ctx / window) * 100);

  writeHandoff({ ...(handoff || {}), compactAdvisedAt: ctx });

  return (
    `[context] ${Math.round(ctx / 1000)}k of ~${window / 1000}k window (${pct}%)${cost}. ` +
    'Compact at a phase boundary (research->plan, plan->build, after a failed approach), ' +
    'not mid-implementation. Write the plan to a file first — task lists do not survive /compact.'
  );
}

function readScorecards() {
  try {
    return fs
      .readFileSync(path.join(ROOT, '.claude', 'memory', 'scorecards.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function readHandoff() {
  try {
    return JSON.parse(fs.readFileSync(HANDOFF, 'utf8'));
  } catch {
    return null;
  }
}

function writeHandoff(h) {
  try {
    fs.mkdirSync(path.dirname(HANDOFF), { recursive: true });
    fs.writeFileSync(HANDOFF, JSON.stringify(h), 'utf8');
  } catch {
    // Continuity is a convenience, never a hard dependency.
  }
}

/**
 * SessionStart. The fixed core: the same bounded block every new session gets,
 * regardless of what is asked. Pinned records are the standing policy that must
 * survive a model swap or a context reset.
 */
function modeCore() {
  const input = parseInput();
  const store = openStore();
  const out = [];

  if (store) {
    const core = store.coreRecords({ budgetTokens: CORE_BUDGET });
    if (core.length) out.push(`[core] ${core.map((r) => r.text).join(' | ')}`);
  }

  const h = readHandoff();
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

  const advice = compactAdvice(input, h);
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

    writeHandoff({
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

const mode = process.argv[2];
if (mode === 'core') modeCore();
else if (mode === 'recall') modeRecall();
else if (mode === 'finalize') modeFinalize();
else process.exit(0);
