#!/usr/bin/env node
'use strict';

/**
 * A bounded Ralph loop: the Stop hook re-feeds the same prompt until Claude
 * genuinely writes the completion promise, or the iteration cap is reached.
 *
 * An independent Node implementation of the technique (Geoffrey Huntley; see
 * also Anthropic's ralph-loop plugin). It needs no jq or perl, so it runs under
 * Git Bash on Windows, and it differs on purpose:
 *
 * - The cap is mandatory. Every iteration re-reads the whole context, so an
 *   unbounded loop is the most expensive thing a session can do.
 * - State is keyed by session id and kept under ~/.claude, never in the project:
 *   no other session is ever blocked, and nothing lands in a repo's working tree.
 * - The promise only counts when Claude itself says it during this iteration —
 *   not in tool output (the start instructions quote it) and not from earlier.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_MAX = 10;
const HARD_MAX = 100;

const normalise = (s) => String(s).replace(/\s+/g, ' ').trim();

function loopDir(env = process.env) {
  return env.TOKEN_HARNESS_LOOP_DIR || path.join(os.homedir(), '.claude', 'token-harness', 'loops');
}

// Session ids come from hook input; strip anything that could walk out of the directory.
function statePath(sessionId, env = process.env) {
  const id = String(sessionId || '').replace(/[^A-Za-z0-9_-]/g, '');
  return id ? path.join(loopDir(env), `${id}.json`) : null;
}

function readState(sessionId, env = process.env) {
  const p = statePath(sessionId, env);
  if (!p) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function writeState(state, env = process.env) {
  const p = statePath(state.sessionId, env);
  if (!p) throw new Error('loop state needs a session id');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

function clearState(sessionId, env = process.env) {
  const p = statePath(sessionId, env);
  if (!p) return false;
  try {
    fs.unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

/** @param {string[]} argv */
function parseArgs(argv) {
  const words = [];
  const errors = [];
  let max = DEFAULT_MAX;
  let promise = null;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--max-iterations') {
      const v = argv[++i];
      if (!/^\d+$/.test(String(v)) || Number(v) < 1) {
        errors.push('--max-iterations needs a whole number of at least 1 (unbounded loops are not allowed)');
      } else {
        max = Number(v);
      }
    } else if (a === '--completion-promise' || a === '--promise') {
      const v = argv[++i];
      if (!v || !normalise(v)) errors.push(`${a} needs text`);
      else promise = normalise(v);
    } else {
      words.push(a);
    }
  }

  if (max > HARD_MAX) {
    errors.push(`--max-iterations is capped at ${HARD_MAX}: every iteration re-reads the whole context`);
  }
  const prompt = words.join(' ').trim();
  if (!prompt) errors.push('no prompt given');
  return { prompt, max, promise, errors };
}

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} [env]
 */
function start(argv, env = process.env) {
  const a = parseArgs(argv);
  const sessionId = env.CLAUDE_CODE_SESSION_ID;
  if (!sessionId) a.errors.push('CLAUDE_CODE_SESSION_ID is not set: start the loop from inside a Claude Code session');
  if (a.errors.length) return { errors: a.errors, state: null };

  const now = new Date().toISOString();
  const state = {
    sessionId,
    prompt: a.prompt,
    iteration: 1,
    maxIterations: a.max,
    promise: a.promise,
    startedAt: now,
    iterationStartedAt: now,
  };
  writeState(state, env);
  return { errors: [], state };
}

/** Every <promise> Claude itself wrote in the transcript since `sinceIso`. */
function promisesSince(transcriptPath, sinceIso, tailBytes = 512000) {
  if (!transcriptPath) return [];
  const { readTailLines } = require('./outcome/transcript.cjs');
  const lines = readTailLines(transcriptPath, tailBytes) || [];
  const since = sinceIso ? Date.parse(sinceIso) : NaN;
  const found = [];

  for (const line of lines) {
    if (!line.includes('<promise>')) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!o || o.type !== 'assistant' || !Array.isArray(o.message?.content)) continue;
    if (!Number.isNaN(since) && o.timestamp && Date.parse(o.timestamp) < since) continue;

    for (const block of o.message.content) {
      if (!block || block.type !== 'text' || typeof block.text !== 'string') continue;
      const re = /<promise>([\s\S]*?)<\/promise>/g;
      let m;
      while ((m = re.exec(block.text))) found.push(normalise(m[1]));
    }
  }
  return found;
}

const validState = (s) => Boolean(
  s
  && Number.isInteger(s.iteration)
  && Number.isInteger(s.maxIterations)
  && typeof s.prompt === 'string'
  && s.prompt.trim(),
);

/**
 * What the Stop hook should do for this session: `null` lets it stop silently,
 * `{ stop }` ends the loop with a note, `{ block }` is the hook output that feeds
 * the prompt back.
 *
 * @param {{session_id?: string, transcript_path?: string}} input
 * @param {NodeJS.ProcessEnv} [env]
 */
function decideStop(input, env = process.env) {
  const sessionId = input && input.session_id;
  const p = statePath(sessionId, env);
  if (!p || !fs.existsSync(p)) return null;

  const state = readState(sessionId, env);
  if (!validState(state)) {
    // Blocking on state we cannot read could trap the session; end the loop instead.
    clearState(sessionId, env);
    return { stop: 'the loop state was unreadable, so the loop ended' };
  }

  if (state.promise && promisesSince(input.transcript_path, state.iterationStartedAt).includes(state.promise)) {
    clearState(sessionId, env);
    return { stop: `completion promise "${state.promise}" met after ${state.iteration} iteration(s)` };
  }

  if (state.iteration >= state.maxIterations) {
    clearState(sessionId, env);
    const why = state.promise ? ` without the promise "${state.promise}"` : '';
    return { stop: `reached the cap of ${state.maxIterations} iteration(s)${why}` };
  }

  const next = { ...state, iteration: state.iteration + 1, iterationStartedAt: new Date().toISOString() };
  writeState(next, env);
  const finish = state.promise
    ? `write <promise>${state.promise}</promise> only when it is completely true`
    : `it ends after iteration ${state.maxIterations}`;
  return {
    block: {
      decision: 'block',
      reason: state.prompt,
      systemMessage: `[loop] iteration ${next.iteration}/${next.maxIterations} | ${finish} | cancel: rcskills loop cancel`,
    },
  };
}

function main(argv = process.argv.slice(2), env = process.env) {
  const [cmd, ...rest] = argv;

  if (cmd === 'start') {
    const r = start(rest, env);
    const s = r.state;
    if (!s) {
      console.error(`loop not started:\n  ${r.errors.join('\n  ')}`);
      process.exitCode = 1;
      return;
    }
    console.log(`[loop] started: up to ${s.maxIterations} iteration(s) in this session.`);
    if (s.promise) console.log(`Finish by writing <promise>${s.promise}</promise> — only when that is completely true.`);
    else console.log('No completion promise: the loop runs until the iteration cap.');
    console.log('Cancel any time: rcskills loop cancel');
    console.log(`\n${s.prompt}`);
    return;
  }

  if (cmd === 'status') {
    const s = readState(env.CLAUDE_CODE_SESSION_ID, env);
    if (!s) {
      console.log('[loop] no active loop in this session');
      return;
    }
    console.log(`[loop] iteration ${s.iteration}/${s.maxIterations}: ${s.prompt}`);
    if (s.promise) console.log(`completion promise: ${s.promise}`);
    return;
  }

  if (cmd === 'cancel') {
    if (rest.includes('--all')) {
      const dir = loopDir(env);
      let n = 0;
      try {
        for (const f of fs.readdirSync(dir)) {
          if (!f.endsWith('.json')) continue;
          fs.unlinkSync(path.join(dir, f));
          n++;
        }
      } catch {
        // No loop directory means nothing to cancel.
      }
      console.log(`[loop] cancelled ${n} loop(s)`);
      return;
    }
    const s = readState(env.CLAUDE_CODE_SESSION_ID, env);
    if (!clearState(env.CLAUDE_CODE_SESSION_ID, env)) {
      console.log('[loop] no active loop in this session (use --all to clear every session)');
      return;
    }
    console.log(`[loop] cancelled at iteration ${s ? s.iteration : '?'}`);
    return;
  }

  console.log('usage: rcskills loop start "<prompt>" [--max-iterations N] [--completion-promise TEXT]');
  console.log('       rcskills loop status | cancel [--all]');
}

if (require.main === module) main();

module.exports = {
  parseArgs, start, decideStop, promisesSince, readState, statePath, loopDir, DEFAULT_MAX, HARD_MAX,
};
