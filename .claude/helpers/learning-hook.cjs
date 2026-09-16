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

/**
 * The compaction prompt, governed by `rcskills config compact ...`. The prompt
 * point is worked out per session from the model, where the work is and how fast
 * context is growing — SessionStart alone could never notice a session growing.
 */
function compactPrompt(tokens, input, activity, extra = {}) {
  const compactMod = req('compact.cjs');
  const configMod = req('config.cjs');
  if (!compactMod || !configMod || !tokens) return null;

  const result = compactMod.adviseCompact({
    tokens,
    sessionId: input.session_id || null,
    state: readJsonFile(COMPACT_STATE),
    settings: configMod.load().compact,
    model: activity ? activity.model : null,
    phase: activity ? activity.phase : null,
    rewriteUsd: extra.rewriteUsd || null,
  });
  writeJsonFile(COMPACT_STATE, result.state);
  return result.message;
}

/**
 * A directive, not a hint. The advisory "Mechanical subtasks -> Agent tool" line was
 * attached to 9 real turns and acted on in none, so the line now names the exact
 * subagent and the brief it needs, and fires only on the router's measured rule.
 */
function routerNote(r, neighbors) {
  // The cost model already demands a 15% margin against this session's real context.
  if (r.direction === 'down') {
    const ev = neighbors.length >= 2 ? `, ${neighbors.length} similar past turns` : '';
    const ctx = `${Math.round(r.contextTokens / 1000)}k`;
    return `[router] delegate -> haiku (${r.tier}, score ${r.score}${ev}; ~${r.savedPct}% cheaper than ${r.sessionModel} at ${ctx} context). ` +
      `Call the Agent tool with subagent_type "${AGENT_PREFIX}${r.agentType}" and model "haiku", passing a self-contained brief: ` +
      'the files, the exact change, and the command that verifies it. Check its result. ' +
      'Stay inline only if the brief would need this conversation\'s history.';
  }
  if (r.direction === 'up') {
    return `[router] escalate -> opus (${r.tier}; this session runs ${r.sessionModel}). ` +
      `Hand the reasoning-heavy core to the Agent tool with subagent_type "${AGENT_PREFIX}${r.agentType}" and model "opus", ` +
      'with a complete brief, and keep the mechanical parts here.';
  }
  return null;
}

/**
 * Wording cannot tell moderate work from complex (17 of 29 "moderate" predictions
 * were complex), so Sonnet is suggested from what the session actually did: when the
 * last 6 completed turns on an Opus or Fable session were all small, and at least 3
 * of them real edits or commands, the user hears once per session that a cheaper
 * model would do.
 */
function modelSwitchNote(activity, input, scoreMod) {
  if (!activity || !scoreMod || !Array.isArray(activity.recent)) return null;
  if (!/opus|fable/i.test(String(activity.model || ''))) return null;
  const last = activity.recent.slice(-6);
  if (last.length < 6) return null;
  if (!last.every((t) => ['trivial', 'simple'].includes(scoreMod.actualTier(t)))) return null;
  if (last.filter((t) => t.edits + t.commands > 0).length < 3) return null;

  const sessionId = input.session_id || null;
  const state = readJsonFile(SWITCH_STATE);
  if (state && state.sessionId === sessionId) return null;
  writeJsonFile(SWITCH_STATE, { sessionId, at: Date.now() });
  // A switch re-caches the whole context on the new model once. It repays itself in
  // about 13 requests at any size, but costs least right after a compaction.
  const costMod = req('model-router/cost.cjs');
  const sonnet = costMod && costMod.rate('claude-sonnet-5');
  const rewrite = sonnet && activity.tokens >= 150000
    ? ` Switching re-caches this ${Math.round(activity.tokens / 1000)}k context once (~$${((activity.tokens * sonnet.in * 2) / 1e6).toFixed(2)}), so it is cheapest right after a /compact.`
    : '';
  return `[router] The last 6 turns on ${activity.model} were all small work. Tell the user in one sentence that ` +
    '`/model sonnet` (or `/model opusplan`: Opus to plan, Sonnet to build) would handle a stretch like this for ' +
    `about 60% less, and \`/model opus\` switches back for hard work.${rewrite}`;
}

/** A redacted summary of this session, which SessionStart shows after /clear. */
function writeHandoff(guardMod, activity, sessionId) {
  const storeMod = req('memory/store.cjs');
  const redact = storeMod && storeMod.redactSecrets ? storeMod.redactSecrets : (s) => s;
  const summary = guardMod.handoffSummary(activity.handoff);
  if (summary) writeJsonFile(HANDOFF, { at: Date.now(), summary: redact(summary), sessionId });
}

/** Stop: keep a large session's handoff current, so /clear loses nothing. Prints nothing. */
function writeLargeSessionHandoff(input) {
  const guardMod = req('cache-guard.cjs');
  const configMod = req('config.cjs');
  const activity = sessionActivity(input, '');
  if (!guardMod || !configMod || !activity) return;
  try {
    const s = configMod.load().cacheGuard;
    const pr = guardMod.price(activity.tokens, activity.model, activity.cacheTtl);
    if (s.enabled && pr && pr.rewriteUsd - pr.freshUsd >= s.budgetUsd) {
      writeHandoff(guardMod, activity, input.session_id || null);
    }
  } catch {
    // The handoff is a convenience; never fail a stop over it.
  }
}

const parseLine = (l) => {
  try {
    return JSON.parse(l);
  } catch {
    return null;
  }
};

/**
 * Cache lines Claude relays at the end of its reply: why the last turn paid to
 * re-send cached context (once per rewrite), and, in a large session, how long the
 * cache stays cheap. The reply is the channel because the desktop app does not show
 * a Stop hook's systemMessage: the user confirmed a notice sent that way never appeared.
 */
function cacheLines(input, activity, compacting) {
  const guardMod = req('cache-guard.cjs');
  const configMod = req('config.cjs');
  const spendMod = req('outcome/spend.cjs');
  const tsMod = req('outcome/transcript.cjs');
  if (!guardMod || !configMod || !activity) return [];
  const lines = [];
  try {
    const settings = configMod.load().cacheGuard;
    const sessionId = input.session_id || null;
    const now = Date.now();
    const saved = readJsonFile(NOTICE_STATE);
    const state = saved && saved.sessionId === sessionId ? saved : null;
    // A session seen for the first time only reports rewrites from the last half hour.
    const explainedAt = state ? Number(state.explainedAt || 0) : now - 30 * 60000;

    const tPath = input.transcript_path || input.transcriptPath;
    const tail = spendMod && tsMod && tPath ? tsMod.readTailLines(tPath, 2000000) : null;
    if (tail) {
      const fresh = spendMod.classifyRewrites(tail.map(parseLine).filter(Boolean)).filter((ev) => ev.at > explainedAt);
      for (const ev of fresh.slice(-2)) {
        const line = guardMod.explainRewrite(ev, settings);
        if (line) lines.push(line);
      }
    }

    // A compaction prompt already tells the user to shrink the session.
    const notice = compacting
      ? { message: null, state }
      : guardMod.afterReplyNotice({
        tokens: activity.tokens, model: activity.model, cacheTtl: activity.cacheTtl, sessionId, state, settings,
      });
    if (notice.message) lines.push(notice.message);
    writeJsonFile(NOTICE_STATE, { ...(notice.state || {}), sessionId, explainedAt: now });
  } catch {
    // Advice is optional; never block the prompt.
  }
  return lines;
}

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
  if (reason) {
    process.stdout.write(`${JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreModelSwitch', permissionDecision: 'ask', permissionDecisionReason: reason },
    })}\n`);
  }
  process.exit(0);
}

/**
 * Holds the first message after the prompt cache expires, once, when re-caching this
 * session costs clearly more than starting fresh. Writes a handoff first, so /clear
 * loses nothing. Any failure lets the prompt through.
 */
function coldCacheBlock(input, prompt, activity) {
  const guardMod = req('cache-guard.cjs');
  const configMod = req('config.cjs');
  if (!guardMod || !configMod || !activity) return null;
  try {
    const sessionId = input.session_id || null;
    const result = guardMod.adviseColdCache({
      prompt,
      tokens: activity.tokens,
      model: activity.model,
      lastResponseAt: activity.lastResponseAt,
      cacheTtl: activity.cacheTtl,
      sessionId,
      state: readJsonFile(GUARD_STATE),
      settings: configMod.load().cacheGuard,
    });
    if (!result.block) return null;

    writeHandoff(guardMod, activity, sessionId);
    writeJsonFile(GUARD_STATE, result.state);
    return result.block;
  } catch {
    return null;
  }
}

function modeRecall() {
  const input = parseInput();
  const prompt = String(input.prompt || '').trim();
  if (!prompt) process.exit(0);

  const activity = sessionActivity(input, prompt);
  const hold = coldCacheBlock(input, prompt, activity);
  if (hold) {
    process.stdout.write(`${JSON.stringify({ decision: 'block', reason: hold })}\n`);
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

  const neighbors = findNeighbors(store, prompt, scoreMod);

  if (router) {
    try {
      const note = routerNote(router.recommend(prompt, {
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
  const switchNote = modelSwitchNote(activity, input, scoreMod);
  if (switchNote) out.push(switchNote);

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

  let advice = null;
  if (activity && activity.tokens) {
    advice = compactPrompt(activity.tokens, input, activity);
    if (advice) out.push(advice);
  }
  out.push(...cacheLines(input, activity, Boolean(advice)));

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

  const advice = compactPrompt(Number(input.context_tokens || 0), input, sessionActivity(input, ''), {
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
    writeLargeSessionHandoff(input);
  }
  process.exit(0);
}

// Inside the harness repo the project settings already run this hook; a global
// copy firing as well would double every outcome record.
if (GLOBAL && samePath(ROOT, HARNESS_ROOT)) process.exit(0);

/** True when `rcskills install` already wired this hook into settings Claude Code reads. */
function settingsInstallPresent() {
  const files = [
    path.join(os.homedir(), '.claude', 'settings.json'),
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
