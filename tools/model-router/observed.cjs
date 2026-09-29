'use strict';

/**
 * What a task really costs on each model, in this user's own sessions — their effort
 * setting, their kind of work — kept beside the Coding Agent Index, which is one run
 * at max effort. Each completed turn is priced on the model that ran it and filed by
 * how big it turned out (outcome/score.cjs). Only complex turns are compared: a
 * question costs the same anywhere, and mixing sizes would compare workloads, not
 * models.
 *
 * Observational, not controlled: two models never did the same task. So local numbers
 * replace the benchmark only once both models have MIN_TASKS complex turns, and the
 * median is used so one runaway task cannot decide it.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const cost = require('./cost.cjs');
const { parseTranscript, isHumanPrompt } = require('../outcome/transcript.cjs');
const { actualTier } = require('../outcome/score.cjs');

const MIN_TASKS = 15;
const KEEP_PER_MODEL = 200;

function storePath(env = process.env) {
  if (env.TOKEN_HARNESS_MODEL_COSTS) return env.TOKEN_HARNESS_MODEL_COSTS;
  // Under node --test (and any hook a test spawns, which inherits the variable) the
  // user's real record is never read or written: tests stay deterministic, and the
  // record stays the user's.
  if (env.NODE_TEST_CONTEXT) return path.join(os.tmpdir(), `rcskills-test-model-costs-${process.pid}.json`);
  return path.join(os.homedir(), '.claude', 'token-harness', 'model-costs.json');
}

/** USD of one request's usage on `model`, at list price. */
function usageUsd(model, u) {
  const r = cost.rate(model);
  const read = cost.cacheReadRate(model);
  if (!r || read === null || read === undefined || !u) return null;
  const cc = u.cache_creation || {};
  const w1 = cc.ephemeral_1h_input_tokens || 0;
  const w5 = cc.ephemeral_5m_input_tokens || Math.max(0, (u.cache_creation_input_tokens || 0) - w1);
  return ((u.cache_read_input_tokens || 0) * read + w5 * r.in * 1.25 + w1 * r.in * 2
    + (u.input_tokens || 0) * r.in + (u.output_tokens || 0) * r.out) / 1e6;
}

/**
 * Every turn in a transcript with its model, cost and size. The model is the one
 * that made most of the turn's requests; each request is counted once.
 * @param {string} filePath
 * @param {{tailLines?: number}} [opts]
 */
function turnCosts(filePath, opts = {}) {
  const shapes = parseTranscript(filePath, opts);
  if (!shapes.length) return [];
  const lines = opts.tailLines
    ? require('../outcome/transcript.cjs').readTailLines(filePath, opts.tailLines * 4000) || []
    : fs.readFileSync(filePath, 'utf8').split('\n');

  /** @type {Array<{usd: number, requests: number, models: Record<string, number>}>} */
  const spend = [];
  let cur = null;
  const seen = new Set();
  for (const line of lines) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (isHumanPrompt(o)) {
      cur = { usd: 0, requests: 0, models: {} };
      spend.push(cur);
      continue;
    }
    if (!cur || o.type !== 'assistant' || !o.message || !o.message.usage) continue;
    const id = o.requestId || o.message.id;
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    const model = cost.normalizeModel(o.message.model);
    const usd = model ? usageUsd(model, o.message.usage) : null;
    if (usd === null) continue;
    cur.usd += usd;
    cur.requests++;
    cur.models[model] = (cur.models[model] || 0) + 1;
  }

  // Both passes start a turn at the same human prompts; align from the end, since a
  // tail read may cut the first turn short in one pass and not the other.
  const out = [];
  const n = Math.min(shapes.length, spend.length);
  for (let i = 1; i <= n; i++) {
    const shape = shapes[shapes.length - i];
    const s = spend[spend.length - i];
    const model = Object.entries(s.models).sort((a, b) => b[1] - a[1])[0];
    if (!model || s.requests === 0) continue;
    out.unshift({ id: shape.promptId, model: model[0], usd: s.usd, requests: s.requests, tier: actualTier(shape) });
  }
  return out;
}

function load(file = storePath()) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' && data.models ? data : { models: {} };
  } catch {
    return { models: {} };
  }
}

/**
 * Add complex turns to the store, once each, keeping the latest KEEP_PER_MODEL per
 * model. Returns how many were new.
 * @param {Array<{id: string, model: string, usd: number, tier: string, requests?: number, paired?: boolean}>} turns
 */
function record(turns, file = storePath()) {
  const data = load(file);
  let added = 0;
  for (const t of turns) {
    if (t.tier !== 'complex' || !t.id || !(t.usd > 0)) continue;
    const m = (data.models[t.model] = data.models[t.model] || { tasks: [] });
    const known = m.tasks.find((x) => x.id === t.id);
    if (known) {
      // Records from before request counts were kept get theirs on the next pass.
      if (!known.requests && t.requests) {
        known.requests = t.requests;
        added++;
      }
      continue;
    }
    m.tasks.push({ id: t.id, usd: Number(t.usd.toFixed(4)), requests: t.requests || 0, ...(t.paired ? { paired: true } : {}) });
    if (m.tasks.length > KEEP_PER_MODEL) m.tasks.splice(0, m.tasks.length - KEEP_PER_MODEL);
    added++;
  }
  if (added) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  }
  return added;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Median cost of a complex task per model, and how many tasks it rests on — split into
 * what a request costs and how many requests a task takes, so a difference between
 * models shows whether it is price or steps.
 * @param {{models: Record<string, {tasks: Array<{usd: number, requests?: number, paired?: boolean}>}>}} data
 */
function summarize(data) {
  /** @type {Record<string, {tasks: number, usdPerTask: number, usdPerRequest: number|null, requestsPerTask: number|null, paired: {tasks: number, usdPerTask: number}|null}>} */
  const out = {};
  for (const [model, m] of Object.entries((data && data.models) || {})) {
    const tasks = (m.tasks || []).filter((t) => t.usd > 0);
    if (!tasks.length) continue;
    const counted = tasks.filter((t) => (t.requests || 0) > 0);
    out[model] = {
      tasks: tasks.length,
      usdPerTask: median(tasks.map((t) => t.usd)),
      usdPerRequest: counted.length ? median(counted.map((t) => t.usd / (t.requests || 1))) : null,
      requestsPerTask: counted.length ? median(counted.map((t) => t.requests || 0)) : null,
      // Same task on each model (rcskills compare): the controlled comparison.
      paired: tasks.some((t) => t.paired)
        ? { tasks: tasks.filter((t) => t.paired).length, usdPerTask: median(tasks.filter((t) => t.paired).map((t) => t.usd)) }
        : null,
    };
  }
  return out;
}

function formatSummary(sum) {
  const rows = Object.entries(sum).sort((a, b) => b[1].tasks - a[1].tasks);
  if (!rows.length) return 'cost per complex task on your sessions: none recorded yet';
  return ['cost per complex task on your sessions (median, list price):',
    ...rows.map(([m, s]) => {
      const split = s.usdPerRequest !== null && s.requestsPerTask !== null
        ? ` ($${s.usdPerRequest.toFixed(3)} a request x ${Math.round(s.requestsPerTask)} requests)` : '';
      return `  ${m.padEnd(20)} $${s.usdPerTask.toFixed(2)}${split} over ${s.tasks} task(s)${s.tasks < MIN_TASKS ? ` — ${MIN_TASKS} needed to count` : ''}`;
    }),
  ].join('\n');
}

module.exports = { turnCosts, record, load, summarize, formatSummary, usageUsd, storePath, MIN_TASKS };
