#!/usr/bin/env node
'use strict';

/**
 * Closes the loop between routing and outcomes.
 *
 *   core     (SessionStart)     - fixed core memory, last-session handoff, compaction prompt
 *   recall   (UserPromptSubmit) - relevant memory, routing advice and compaction prompt
 *   loop     (Stop)             - keep a `rcskills loop` going until its promise or cap
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
// Installed as a Claude Code plugin: subagents are namespaced by the plugin name.
const PLUGIN = process.argv.includes('--plugin');
const AGENT_PREFIX = PLUGIN ? 'rcskills:' : '';
// strict profile: record each turn's outcome from the Stop hook that already runs.
const LEARN = process.argv.includes('--learn');

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
const SWITCH_STATE = path.join(DATA, 'model-switch-state.json');
const SWITCH_HANDOFF = path.join(DATA, 'switch-handoff.json');
const GUARD_STATE = path.join(DATA, 'cache-guard-state.json');
const NOTICE_STATE = path.join(DATA, 'cache-notice-state.json');
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

function sessionActivity(input, currentPrompt) {
  const tsMod = req('outcome/transcript.cjs');
  const tPath = input.transcript_path || input.transcriptPath;
  if (!tsMod || !tPath) return null;
  try {
    return tsMod.recentActivity(tPath, { currentPrompt });
  } catch {
    return null;
  }
}

// Advice lines (compaction, cache, model switching, handoffs) live in tools/hook-advice.cjs.
const NO_ADVICE = {
  finish: (lines) => lines,
  compactPrompt: () => null,
  findNeighbors: () => [],
  routerNote: () => null,
  modelSwitchAdvice: () => ({ message: null, hold: null }),
  switchHandoffLine: () => null, writeLargeSessionHandoff: () => {},
  cacheLines: () => [],
  captureSwitchHandoff: () => {}, recordTaskCosts: () => {},
  coldCacheBlock: () => null,
};
const advice = (() => {
  const create = req('hook-advice.cjs');
  try {
    return create ? create({
      req, readJsonFile, writeJsonFile, sessionActivity, AGENT_PREFIX, MAX_NEIGHBORS,
      paths: { COMPACT_STATE, SWITCH_STATE, SWITCH_HANDOFF, GUARD_STATE, NOTICE_STATE, HANDOFF },
    }) : NO_ADVICE;
  } catch {
    return NO_ADVICE;
  }
})();

/** The reasoning carried across a model switch, shown once on the next prompt. */
/** A redacted summary of this session, which SessionStart shows after /clear. */
/** Stop: keep a large session's handoff current, so /clear loses nothing. Prints nothing. */
/**
 * PreModelSwitch. Re-selecting the model already in use only re-caches the context,
 * so the user is asked first. Runs only when the model changes: no per-turn cost.
 */
function modeSwitch() {
  const input = parseInput();
  const guardMod = req('cache-guard.cjs');
  const configMod = req('config.cjs');
  let reason = null;
  try {
    const enabled = !configMod || configMod.load().cacheGuard.enabled;
    reason = guardMod && enabled ? guardMod.adviseModelSwitch(input) : null;
  } catch {
    reason = null;
  }
  advice.captureSwitchHandoff(input);
  if (reason) {
    process.stdout.write(`${JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreModelSwitch', permissionDecision: 'ask', permissionDecisionReason: reason },
    })}\n`);
  }
  process.exit(0);
}

function modeRecall() {
  const input = parseInput();
  const prompt = String(input.prompt || '').trim();
  if (!prompt) process.exit(0);

  const activity = sessionActivity(input, prompt);
  const hold = advice.coldCacheBlock(input, prompt, activity);
  if (hold) {
    process.stdout.write(`${JSON.stringify({ decision: 'block', reason: hold })}\n`);
    process.exit(0);
  }
  const modelAdvice = advice.modelSwitchAdvice(activity, input, prompt);
  if (modelAdvice.hold) {
    process.stdout.write(`${JSON.stringify({ decision: 'block', reason: modelAdvice.hold })}\n`);
    process.exit(0);
  }

  writeJsonFile(STATE, {
    prompt: prompt.slice(0, 500),
    promptId: input.prompt_id || input.promptId || null,
    startedAt: Date.now(),
  });

  const store = openStore();
  const scoreMod = req('outcome/score.cjs');
  const router = req('model-router/index.cjs');
  const out = [];
  const handoff = advice.switchHandoffLine(input);
  if (handoff) out.push(handoff);

  const neighbors = advice.findNeighbors(store, prompt, scoreMod);

  // The session-model advice already says Opus; an escalate line on top would repeat it.
  if (router && !(modelAdvice.message && /\/model claude-opus/.test(modelAdvice.message))) {
    try {
      const note = advice.routerNote(router.recommend(prompt, {
        repoRoot: ROOT,
        neighbors,
        sessionModel: activity && activity.model ? activity.model : undefined,
        // Delegation pays only against the context this session really re-reads,
        // and a subagent is far cheaper while a recent run left its prefix cached.
        contextTokens: activity && activity.tokens ? activity.tokens : undefined,
        warmSubagent: Boolean(activity && activity.lastAgentAt && Date.now() - activity.lastAgentAt < 5 * 60 * 1000),
      }), neighbors);
      if (note) out.push(note);
    } catch {
      // Routing advice is optional; never block the prompt.
    }
  }
  if (modelAdvice.message) out.push(modelAdvice.message);

  if (store) {
    try {
      const rec = store.recall(prompt, { budgetTokens: RECALL_BUDGET, limit: 3 });
      // Core records are already in context from SessionStart; repeating them costs
      // tokens on every prompt and tells Claude nothing new.
      const core = new Set(coreTexts());
      const notes = rec.records.filter((r) => r.kind !== 'outcome' && !core.has(r.text));
      if (notes.length) {
        out.push(`[memory] ${notes.map((r) => r.text).join(' | ')}`);
      }
      store.save();
    } catch {
      // Recall is best-effort.
    }
  }

  // One [next] line per reply: a model line already carries its own /compact.
  let compactLine = null;
  if (activity && activity.tokens) {
    compactLine = advice.compactPrompt(activity.tokens, input, activity, { focus: prompt });
    if (compactLine && !modelAdvice.message) out.push(compactLine);
  }
  out.push(...advice.cacheLines(input, activity, Boolean(compactLine || modelAdvice.message)));

  const said = advice.finish(out);
  if (said.length) process.stdout.write(`${said.join('\n')}\n`);
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
 * One line, once, on the first session after installing.
 *
 * Everything else here stays silent until there is money on the table, so a fresh
 * install says nothing for hours and reads as broken. The marker is written first:
 * if it cannot be recorded, say nothing rather than risk repeating it every session.
 */
function firstRunLine() {
  const home = GLOBAL ? path.join(os.homedir(), '.claude', 'token-harness') : DATA;
  const marker = path.join(home, 'first-run.json');
  if (fs.existsSync(marker)) return null;
  try {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, JSON.stringify({ at: Date.now() }), 'utf8');
  } catch {
    return null;
  }
  return (
    '[rcskills] Installed. You will get a line before this session\'s prompt cache lapses, ' +
    'when context grows expensive enough to /compact, and when small work should go to a ' +
    'cheaper model — and nothing at all when there is nothing worth saying. It reads only ' +
    'local transcripts; nothing leaves this machine. What past sessions cost: rcskills spend'
  );
}

/**
 * SessionStart. The fixed core: the same bounded block every new session gets,
 * regardless of what is asked. Pinned records are the standing policy that must
 * survive a model swap or a context reset.
 */
function modeCore() {
  const input = parseInput();
  const out = [];

  const greeting = firstRunLine();
  if (greeting) out.push(greeting);

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

  const compactLine = advice.compactPrompt(Number(input.context_tokens || 0), input, sessionActivity(input, ''), {
    rewriteUsd: Number(input.estimated_cache_write_usd || 0) || null,
  });
  if (compactLine) out.push(compactLine);

  const said = advice.finish(out);
  if (said.length) process.stdout.write(`${said.join('\n')}\n`);
  process.exit(0);
}

/**
 * Stop. Derives what the turn actually cost from the transcript rather than
 * counting live: a PostToolUse hook spawned one node process per tool call
 * (~166ms measured), while the transcript already holds the same facts.
 */
/** Stores what the finished turn actually did, so the router learns from outcomes. */
function recordOutcome(input) {
  const scoreMod = req('outcome/score.cjs');
  const tsMod = req('outcome/transcript.cjs');
  const store = openStore();
  if (!scoreMod || !tsMod || !store) return;

  const tPath = input.transcript_path || input.transcriptPath;
  if (!tPath) return;

  let turn;
  try {
    turn = tsMod.lastTurn(tPath);
  } catch {
    return;
  }
  if (!turn || !turn.prompt) return;

  const obs = {
    edits: turn.edits,
    commands: turn.commands,
    reads: turn.reads,
    distinctFiles: turn.distinctFiles,
  };

  // A turn that did nothing observable teaches nothing worth storing.
  if (obs.edits + obs.commands + obs.reads === 0) return;

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
}

function learningOn() {
  if (LEARN) return true;
  try {
    const configMod = req('config.cjs');
    return Boolean(configMod && configMod.load().learning);
  } catch {
    return false;
  }
}

/** Kept for settings written by 1.0 strict installs; re-installing folds it into loop. */
function modeFinalize() {
  recordOutcome(parseInput());
  process.exit(0);
}

/**
 * Stop. Keeps a `rcskills loop` running: feeds its prompt back until the
 * completion promise is genuinely written or the iteration cap is reached.
 * Without a loop it keeps a large session's handoff current. It prints nothing
 * then, so it costs one spawn and no tokens.
 */
function modeLoop() {
  const input = parseInput();
  if (learningOn()) recordOutcome(input);
  advice.recordTaskCosts(input);
  const loop = req('loop.cjs');
  let decision = null;
  try {
    decision = loop ? loop.decideStop(input) : null;
  } catch {
    decision = null;
  }
  if (decision) {
    const out = decision.block || { systemMessage: `[loop] ${decision.stop}` };
    process.stdout.write(`${JSON.stringify(out)}\n`);
  } else {
    advice.writeLargeSessionHandoff(input);
  }
  process.exit(0);
}

// Inside the harness repo the project settings already run this hook; a global
// copy firing as well would double every outcome record.
if (GLOBAL && samePath(ROOT, HARNESS_ROOT)) process.exit(0);

/** True when `rcskills install` already wired this hook into settings Claude Code reads. */
function settingsInstallPresent() {
  const files = [
    path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json'),
    path.join(ROOT, '.claude', 'settings.json'),
    path.join(ROOT, '.claude', 'settings.local.json'),
  ];
  return files.some((f) => {
    try {
      return fs.readFileSync(f, 'utf8').includes('learning-hook.cjs');
    } catch {
      return false;
    }
  });
}

// Installed both ways, the settings copy runs and the plugin copy stands down, so
// no advice line or memory record is ever doubled.
if (PLUGIN && settingsInstallPresent()) process.exit(0);

const mode = process.argv[2];
if (mode === 'core') modeCore();
else if (mode === 'recall') modeRecall();
else if (mode === 'loop') modeLoop();
else if (mode === 'finalize') modeFinalize();
else if (mode === 'switch') modeSwitch();
else process.exit(0);
