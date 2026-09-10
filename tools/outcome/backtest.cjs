'use strict';

const { classify } = require('../model-router/index.cjs');
const { actualTier, tierDelta, TIERS } = require('./score.cjs');
const { parseTranscript, findTranscripts } = require('./transcript.cjs');

const DELEGATE_TIERS = new Set(['trivial', 'simple']);

/**
 * Replay real turns through the router and compare its prediction to what the
 * work actually turned out to be.
 *
 * The headline number is not accuracy — it is underRouted. Predicting too
 * cheap sends a hard task to a weak model; predicting too rich only wastes
 * money. Those errors are not symmetric.
 */
function backtest(turns, opts = {}) {
  const rows = [];
  const matrix = {};
  for (const p of TIERS) {
    matrix[p] = {};
    for (const a of TIERS) matrix[p][a] = 0;
  }

  for (const turn of turns) {
    if (opts.minPromptLength && turn.prompt.length < opts.minPromptLength) continue;

    const predicted = classify(turn.prompt, { repoScore: opts.repoScore || 0 }).tier;
    const actual = actualTier(turn);
    const delta = tierDelta(predicted, actual);

    matrix[predicted][actual] += 1;
    rows.push({
      prompt: turn.prompt.slice(0, 70).replace(/\s+/g, ' '),
      predicted,
      actual,
      delta,
      predDelegate: DELEGATE_TIERS.has(predicted),
      actDelegate: DELEGATE_TIERS.has(actual),
      edits: turn.edits,
      files: turn.distinctFiles,
      commands: turn.commands,
    });
  }

  const n = rows.length;
  const exact = rows.filter((r) => r.delta === 0).length;
  const within1 = rows.filter((r) => Math.abs(r.delta) <= 1).length;
  const under = rows.filter((r) => r.delta < 0);
  const over = rows.filter((r) => r.delta > 0);

  // The decision actually taken is binary: delegate to the weak model or not.
  // trivial/simple confusion is free because both route to haiku, so tier
  // accuracy overstates the harm. This is the metric that maps to real cost.
  const falseDelegate = rows.filter((r) => r.predDelegate && !r.actDelegate);
  const missedSaving = rows.filter((r) => !r.predDelegate && r.actDelegate);
  const binaryCorrect = n - falseDelegate.length - missedSaving.length;

  return {
    n,
    exact,
    within1,
    binaryCorrect,
    binaryCorrectPct: n ? Number(((binaryCorrect / n) * 100).toFixed(1)) : 0,
    falseDelegate: falseDelegate.length,
    falseDelegatePct: n ? Number(((falseDelegate.length / n) * 100).toFixed(1)) : 0,
    missedSaving: missedSaving.length,
    missedSavingPct: n ? Number(((missedSaving.length / n) * 100).toFixed(1)) : 0,
    exactPct: n ? Number(((exact / n) * 100).toFixed(1)) : 0,
    within1Pct: n ? Number(((within1 / n) * 100).toFixed(1)) : 0,
    underRouted: under.length,
    underRoutedPct: n ? Number(((under.length / n) * 100).toFixed(1)) : 0,
    overRouted: over.length,
    overRoutedPct: n ? Number(((over.length / n) * 100).toFixed(1)) : 0,
    severeUnder: under.filter((r) => r.delta <= -2).length,
    matrix,
    rows,
  };
}

function collectTurns(opts = {}) {
  const files = opts.files || findTranscripts(opts.projectsDir);
  const turns = [];
  for (const f of files) {
    for (const t of parseTranscript(f)) turns.push(t);
  }
  return turns;
}

function formatReport(result) {
  const lines = [];
  lines.push(`turns analysed: ${result.n}`);
  lines.push('');
  lines.push('-- delegate / keep decision (what actually costs money) --');
  lines.push(`correct decision: ${result.binaryCorrect}/${result.n} (${result.binaryCorrectPct}%)`);
  lines.push(`false delegate:   ${result.falseDelegate} (${result.falseDelegatePct}%)  <- sent real work to a weak model`);
  lines.push(`missed saving:    ${result.missedSaving} (${result.missedSavingPct}%)  <- paid too much, harmless`);
  lines.push('');
  lines.push('-- tier detail --');
  lines.push(`exact tier match: ${result.exact}/${result.n} (${result.exactPct}%)`);
  lines.push(`within one tier:  ${result.within1}/${result.n} (${result.within1Pct}%)`);
  lines.push(`under-routed:     ${result.underRouted} (${result.underRoutedPct}%)  <- the costly error`);
  lines.push(`  severe (2+):    ${result.severeUnder}`);
  lines.push(`over-routed:      ${result.overRouted} (${result.overRoutedPct}%)  <- merely wasteful`);
  lines.push('');
  lines.push('predicted \\ actual   ' + TIERS.map((t) => t.slice(0, 5).padStart(6)).join(''));
  for (const p of TIERS) {
    lines.push(
      `  ${p.padEnd(18)} ` + TIERS.map((a) => String(result.matrix[p][a]).padStart(6)).join(''),
    );
  }
  return lines.join('\n');
}

module.exports = { backtest, collectTurns, formatReport };
