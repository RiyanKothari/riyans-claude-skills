'use strict';

const TIERS = ['trivial', 'simple', 'moderate', 'complex'];

const TIER_MODEL = {
  trivial: 'claude-haiku-4-5',
  simple: 'claude-haiku-4-5',
  moderate: 'claude-sonnet-5',
  complex: 'claude-opus-5',
};

const TIER_AGENT_MODEL = {
  trivial: 'haiku',
  simple: 'haiku',
  moderate: 'sonnet',
  complex: 'opus',
};

// Measured on 143 real turns that edited or ran something: delegating every
// trivial/simple prediction sent real work to haiku 29.4% of the time, because a
// "simple" rating always sits on a band edge (confidence <= 0.33). Requiring clear
// cheap evidence — score -2 or lower — gave 0 false delegations in that sample and
// 73.4% correct decisions instead of 62.9%.
const DELEGATE_MAX_SCORE = -2;

// Capability order. Older versions are absent on purpose: Opus 4.6-4.8 cost the
// same as Opus 5 and Sonnet 4.6 costs more than Sonnet 5, so none is ever the
// cheapest adequate model. Fable (2x Opus) is never chosen automatically.
/** @type {Record<string, number>} */
const MODEL_RANK = { haiku: 1, sonnet: 2, opus: 3, fable: 4 };

// The model-pinned subagents in agents/, installed with the harness.
/** @type {Record<string, string>} */
const AGENT_TYPE = { haiku: 'rc-haiku', sonnet: 'rc-sonnet', opus: 'rc-opus' };

const HARD_SIGNALS = new Set(['reasoning', 'deep-engineering', 'escalate']);

/** @param {string|null|undefined} model */
function modelFamily(model) {
  const m = String(model || '').toLowerCase().match(/haiku|sonnet|opus|fable/);
  return m ? m[0] : null;
}

/** The shipped delegation rule, shared with the backtest so it measures what runs. */
function shouldDelegateDown(c) {
  return c.score <= DELEGATE_MAX_SCORE;
}

// One price table for the whole harness; see cost.cjs.
const { PRICING, rate } = require('./cost.cjs');

const SIGNALS = [
  {
    name: 'trivial-edit',
    weight: -3,
    tokens: [
      'typo', 'spelling', 'rename', 'formatting', 'format this', 'prettier',
      'lint fix', 'fix lint', 'bump version', 'add a comment', 'remove console',
      'gitignore', 'whitespace', 'indent', 'semicolon', 'trailing comma',
    ],
  },
  {
    name: 'mechanical',
    weight: -2,
    tokens: [
      'add import', 'change the color', 'update the string', 'change the text',
      'add a field', 'rename the variable', 'move the file', 'delete the file',
      'add to the list', 'update the label',
    ],
  },
  {
    name: 'lookup',
    weight: -1,
    tokens: ['where is', 'find the', 'list the', 'show me', 'what file', 'grep'],
  },
  {
    // Backtest finding: status checks, ratings and acknowledgements were the
    // single largest category (38 turns) and produced zero file edits.
    name: 'conversational',
    weight: -3,
    tokens: [
      'rate', 'score', 'out of 100', 'winnability', 'how far behind',
      'is it', 'is that', 'is this', 'are we', 'what are', 'whats', "what's",
      'done', 'redeployed', 'thanks', 'thank you', 'got it', 'is mine',
    ],
  },
  {
    name: 'reasoning',
    weight: 3,
    tokens: [
      'why does', 'why is', 'why did', 'how should', "what's the best", 'what is the best',
      'tradeoff', 'trade-off', 'compare', 'evaluate', 'decide', 'should we',
      'pros and cons', 'approach',
    ],
  },
  {
    name: 'deep-engineering',
    weight: 4,
    tokens: [
      'architect', 'architecture', 'design the', 'redesign', 'migration',
      'race condition', 'concurrency', 'deadlock', 'memory leak', 'performance',
      'optimize', 'security', 'vulnerability', 'threat model', 'refactor',
      'intermittent', 'flaky', 'root cause',
    ],
  },
  {
    name: 'scope',
    weight: 2,
    tokens: [
      'across the codebase', 'entire codebase', 'all files', 'every file',
      'throughout', 'codebase-wide', 'each module', 'whole project',
    ],
  },
  {
    // Backtest finding: short open-ended work orders ("go on", "continue
    // building") triggered the largest tasks in the corpus — up to 36 edits
    // across 15 files. Brevity here means unbounded scope, not small scope.
    name: 'open-ended-work',
    weight: 5,
    tokens: [
      'start building', 'continue building', 'continue working', 'keep going',
      'go on', 'start working', 'lets continue', "let's continue", 'continue with',
      'carry on', 'try again', 'run it', 'fix bugs', 'fix all', 'more innovation',
      'complete it', 'finish it', 'build everything', 'work on everything',
      'continue', 'proceed', 'resume',
    ],
  },
  {
    name: 'escalate',
    weight: 5,
    tokens: [
      'think hard', 'think carefully', 'ultrathink', 'be thorough', 'carefully',
      'production', 'critical', 'do not break', "don't break", 'mission critical',
    ],
  },
];

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildMatcher(tokens) {
  const alts = tokens.map((tok) => {
    const escaped = escapeRegex(tok.toLowerCase());
    return /\s|\//.test(tok) ? escaped : `\\b${escaped}\\b`;
  });
  return new RegExp(`(?:${alts.join('|')})`, 'i');
}

const COMPILED = SIGNALS.map((s) => ({ ...s, regex: buildMatcher(s.tokens) }));

function structuralScore(prompt) {
  let score = 0;
  const words = prompt.trim().split(/\s+/).filter(Boolean).length;

  if (words > 120) score += 2;
  else if (words > 50) score += 1;
  else if (words < 8) score -= 1;

  // A numbered or bulleted list means several deliverables in one prompt.
  const listItems = (prompt.match(/^\s*(?:[-*]|\d+[.)])\s+/gm) || []).length;
  if (listItems >= 3) score += 2;
  else if (listItems === 2) score += 1;

  if ((prompt.match(/\?/g) || []).length >= 2) score += 1;

  return score;
}

// Past tasks that actually turned out harder than they read are the strongest
// available correction to a static keyword guess.
function neighborScore(neighbors) {
  const usable = (neighbors || []).filter(
    (n) => n && typeof n.actualScore === 'number' && typeof n.similarity === 'number',
  );
  if (usable.length < 2) return { delta: 0, n: 0 };

  let wsum = 0;
  let w = 0;
  for (const n of usable) {
    wsum += n.actualScore * n.similarity;
    w += n.similarity;
  }
  if (w === 0) return { delta: 0, n: 0 };

  return { delta: wsum / w, n: usable.length };
}

function classify(prompt, opts = {}) {
  const text = String(prompt ?? '');
  if (!text.trim()) {
    return {
      tier: 'moderate',
      score: 0,
      confidence: 0,
      matched: [],
      escalated: false,
      reason: 'Empty prompt — defaulting to moderate.',
    };
  }

  const matched = [];
  let score = 2;

  for (const sig of COMPILED) {
    if (sig.regex.test(text)) {
      score += sig.weight;
      matched.push({ signal: sig.name, weight: sig.weight });
    }
  }

  score += structuralScore(text);

  const repo = opts.repoScore ?? 0;
  if (repo > 0) {
    score += repo;
    matched.push({ signal: 'repo-blast-radius', weight: repo });
  }

  const nb = neighborScore(opts.neighbors);
  if (nb.n >= 2) {
    // Blend rather than replace: the heuristic still carries half the weight.
    score = Math.round((score + nb.delta) / 2);
    matched.push({ signal: `observed-neighbors(${nb.n})`, weight: 0 });
  }

  let tier;
  if (score <= 0) tier = 'trivial';
  else if (score <= 2) tier = 'simple';
  else if (score <= 6) tier = 'moderate';
  else tier = 'complex';

  const boundaries = [0, 2, 6];
  const distance = Math.min(...boundaries.map((b) => Math.abs(score - b)));
  const confidence = Math.min(1, distance / 3);

  // Never silently downgrade an ambiguous prompt: a too-weak model on a hard
  // task costs a retry, which is more expensive than the tier we saved.
  //
  // But ambiguity is not the same as absence of evidence. A short prompt with
  // no complexity signal at all ("done", "?", "rate this") is not a borderline
  // hard task — it is a conversational turn. Escalating those collapsed the
  // whole trivial tier into moderate and cost 54.7% over-routing on backtest.
  const hasComplexitySignal = matched.some((m) => m.weight > 0);
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  const conversational = !hasComplexitySignal && wordCount <= 14;

  let escalated = false;
  if (confidence < 0.34 && tier !== 'complex' && !conversational) {
    tier = TIERS[TIERS.indexOf(tier) + 1];
    escalated = true;
  }

  return {
    tier,
    score,
    confidence: Number(confidence.toFixed(2)),
    matched,
    escalated,
    reason: buildReason(matched, escalated, tier),
  };
}

function buildReason(matched, escalated, tier) {
  if (matched.length === 0) {
    return escalated
      ? `No strong signals; escalated to ${tier} for safety.`
      : `No strong signals; structural heuristics put this at ${tier}.`;
  }
  const names = matched.map((m) => `${m.signal}(${m.weight > 0 ? '+' : ''}${m.weight})`);
  const base = `Matched ${names.join(', ')}`;
  return escalated ? `${base}; escalated one tier (low confidence).` : base;
}

function estimateCost(model, inTokens, outTokens) {
  const p = rate(model);
  if (!p) return null;
  return (inTokens / 1e6) * p.in + (outTokens / 1e6) * p.out;
}

function recommend(prompt, opts = {}) {
  let repoScore = opts.repoScore ?? 0;
  let repoReason = null;
  if (!repoScore && opts.repoRoot) {
    const { repoSignal } = require('./repo-signal.cjs');
    const sig = repoSignal(prompt, { root: opts.repoRoot });
    repoScore = sig.score;
    repoReason = sig.reason;
  }

  const c = classify(prompt, { repoScore, neighbors: opts.neighbors });
  const model = TIER_MODEL[c.tier];
  const sessionModel = opts.sessionModel || opts.baselineModel || 'claude-opus-5';
  const sessionRank = MODEL_RANK[modelFamily(sessionModel) || ''] || MODEL_RANK.opus;

  const { compare } = require('./cost.cjs');
  const econ = compare({
    sessionModel,
    subModel: TIER_MODEL.trivial,
    // The context this session really re-reads; unknown means a fresh session.
    contextTokens: opts.contextTokens,
    taskCalls: opts.taskCalls,
    handoffTokens: opts.handoffTokens,
    warmSubagent: opts.warmSubagent,
  });

  // Down needs clear cheap evidence, a pricier session model, and a cold subagent
  // that still beats re-reading the context this session already has cached.
  const down = shouldDelegateDown(c) && sessionRank > MODEL_RANK.haiku && econ.winner === 'delegate';
  // Up: a session on a weaker model than a reasoning-heavy task needs hands it on.
  const up = !down && c.tier === 'complex' && sessionRank < MODEL_RANK.opus
    && c.matched.some((m) => HARD_SIGNALS.has(m.signal));
  const delegateTo = down ? 'haiku' : up ? 'opus' : null;

  return {
    ...c,
    repoScore,
    repoReason,
    model,
    agentModel: TIER_AGENT_MODEL[c.tier],
    sessionModel,
    delegate: down,
    direction: down ? 'down' : up ? 'up' : null,
    delegateTo,
    agentType: delegateTo ? AGENT_TYPE[delegateTo] : null,
    estCostUsd: econ.delegate,
    baselineCostUsd: econ.inline,
    contextTokens: econ.contextTokens,
    breakEvenTokens: econ.breakEvenTokens,
    savedUsd: down ? econ.savedUsd : 0,
    savedPct: down ? econ.savedPct : 0,
  };
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const ci = argv.indexOf('--context');
  const contextTokens = ci === -1 ? undefined : Number(argv[ci + 1]) || undefined;
  const prompt = argv.filter((a, i) => a !== '--context' && (ci === -1 || i !== ci + 1)).join(' ');

  if (!prompt) {
    console.log('Usage: node index.cjs <prompt> [--context <session context tokens>]');
    process.exit(0);
  }
  console.log(
    JSON.stringify(recommend(prompt, { repoRoot: process.cwd(), contextTokens }), null, 2),
  );
}

module.exports = {
  classify,
  recommend,
  estimateCost,
  shouldDelegateDown,
  modelFamily,
  TIERS,
  TIER_MODEL,
  TIER_AGENT_MODEL,
  DELEGATE_MAX_SCORE,
  MODEL_RANK,
  AGENT_TYPE,
  PRICING,
};
