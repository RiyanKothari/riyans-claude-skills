'use strict';

/**
 * Seven parameters, weighted to 100.
 *
 * The point is not the number. It is that an unbacked claim cannot score well:
 * parameters with `evidence` are capped until real evidence is supplied, so
 * "it works" without a test run cannot outscore a verified result.
 */
const PARAMETERS = [
  {
    key: 'correctness',
    label: 'Correctness',
    weight: 20,
    evidence: 'test results',
    asks: 'Does it actually work, proven by execution?',
  },
  {
    key: 'verification',
    label: 'Verification',
    weight: 18,
    evidence: 'a command that was run',
    asks: 'Did I prove it, or assert it?',
  },
  {
    key: 'durability',
    label: 'Durability',
    weight: 14,
    evidence: 'changed modules pinned by a changed test, and docs',
    asks: 'Will this survive, or is it a one-off that rots?',
  },
  {
    key: 'scopeFit',
    label: 'Scope fit',
    weight: 14,
    asks: 'Exactly what was asked - nothing gold-plated, nothing skipped?',
  },
  {
    key: 'efficiency',
    label: 'Efficiency',
    weight: 12,
    evidence: 'tool count against the work the turn did',
    asks: 'Was the cheapest adequate path taken, in tokens and in runtime?',
  },
  {
    key: 'honesty',
    label: 'Honesty',
    weight: 12,
    asks: 'Were gaps and failures surfaced without being asked?',
  },
  {
    key: 'completeness',
    label: 'Completeness',
    weight: 10,
    asks: 'Any known gap left open at hand-off?',
  },
];

// A parameter that claims excellence without evidence is capped here. This is
// the whole anti-inflation mechanism: you cannot self-report your way past it.
const UNBACKED_CAP = 5;

// Tool calls a turn of each tier normally needs, from 124 real backtested
// turns. Used to detect thrash, not to reward terseness — coming in under
// the baseline is simply full marks.
const TIER_EXPECTED_TOOLS = { trivial: 2, simple: 5, moderate: 14, complex: 30 };

// Tool calls per distinct file touched, measured across 163 real turns that
// touched at least one file: p25 2.5, p50 4.0, p75 7.0, p90 11.0. Per-turn cost
// varies thirtyfold (complex turns: p50 29 tools, p90 74, max 150) while per-file
// cost barely moves between tiers (simple 3.0, moderate 4.0, complex 4.1), so this
// is the stable invariant and tool count alone was largely measuring how big the
// job was. The tier baseline stays as a floor: it is what a turn touching no files
// is allowed, and a turn that burns 100 calls on two files still scores zero.
const TOOLS_PER_FILE = 4;

const byKey = Object.fromEntries(PARAMETERS.map((p) => [p.key, p]));

function clamp(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(10, v));
}

/**
 * Derive the evidence-backed parameters from facts rather than opinion.
 * `null` for an input means "not measured", which is treated as unbacked.
 */
function fromEvidence(ev = {}) {
  const out = {};

  if (typeof ev.testsPass === 'number' && typeof ev.testsTotal === 'number' && ev.testsTotal > 0) {
    const ratio = clamp((ev.testsPass / ev.testsTotal) * 10);
    // A red suite is a binary fact, not a percentage: 217/218 once scored 10/10
    // on a commit that failed CI. Any failure caps correctness at half marks.
    out.correctness = ev.testsPass === ev.testsTotal ? ratio : Math.min(5, ratio);
    out.correctnessBacked = true;
  }

  if (ev.verifyRan) {
    // Running the suite is the floor; coverage decides the rest.
    const cov = typeof ev.coveragePct === 'number' ? ev.coveragePct : null;
    out.verification = cov === null ? 7 : clamp(5 + (cov / 100) * 5);
    out.verificationBacked = true;
  }

  if (typeof ev.testsAdded === 'number' || ev.docsUpdated !== undefined) {
    // When code changed, the tests share is the fraction of changed modules a changed
    // test exercises; test-file volume alone no longer earns it. Docs-only turns keep
    // the old count.
    const sources = Number(ev.sourcesChanged) || 0;
    const untested = Array.isArray(ev.untested) ? Math.min(sources, ev.untested.length) : 0;
    const t = sources > 0
      ? (6 * (sources - untested)) / sources
      : (ev.testsAdded ? Math.min(6, ev.testsAdded) : 0);
    const d = ev.docsUpdated ? 4 : 0;
    out.durability = clamp(t + d);
    out.durabilityBacked = true;
  }

  // Thrash is measurable: a turn burning far more tool calls than the work in it
  // needs was flailing, whatever it felt like from the inside. The allowance is
  // whichever is larger — the tier's baseline, or the measured cost of touching
  // that many files — so a long job is not mistaken for a wasteful one.
  if (typeof ev.toolCount === 'number' && ev.tier && TIER_EXPECTED_TOOLS[ev.tier]) {
    const expected = Math.max(TIER_EXPECTED_TOOLS[ev.tier], TOOLS_PER_FILE * (ev.distinctFiles || 0));
    const ratio = ev.toolCount / expected;
    out.efficiency = clamp(ratio <= 1 ? 10 : 10 - (ratio - 1) * 5);
    out.efficiencyBacked = true;
  }

  return out;
}

function score(input = {}) {
  const evidence = fromEvidence(input.evidence || {});
  const breakdown = [];
  let total = 0;

  for (const p of PARAMETERS) {
    const auto = evidence[p.key];
    const manual = input[p.key];
    const backed = Boolean(evidence[`${p.key}Backed`]);

    let value = auto !== undefined ? auto : clamp(manual);
    let capped = false;

    if (p.evidence && !backed && value > UNBACKED_CAP) {
      value = UNBACKED_CAP;
      capped = true;
    }

    const earned = (value / 10) * p.weight;
    total += earned;

    breakdown.push({
      key: p.key,
      label: p.label,
      weight: p.weight,
      value: Number(value.toFixed(1)),
      earned: Number(earned.toFixed(2)),
      lost: Number((p.weight - earned).toFixed(2)),
      backed,
      capped,
      asks: p.asks,
      note: (input.notes && input.notes[p.key]) || null,
    });
  }

  // The weakest link is the one bleeding the most weighted points, not simply
  // the lowest raw score - a 6/10 on a 20-weight parameter matters more than
  // a 3/10 on a 10-weight one.
  const ranked = [...breakdown].sort((a, b) => b.lost - a.lost);

  return {
    total: Number(total.toFixed(1)),
    breakdown,
    weakest: ranked[0] || null,
    runnersUp: ranked.slice(1, 3),
    cappedCount: breakdown.filter((b) => b.capped).length,
  };
}

function formatCard(result, title) {
  const lines = [];
  lines.push(`## ${title || 'Task scorecard'} — ${result.total}/100`);
  lines.push('');
  lines.push('| Parameter | Score | Weight | Lost |');
  lines.push('|---|---:|---:|---:|');
  for (const b of result.breakdown) {
    const flag = b.capped ? ' (capped: no evidence)' : '';
    lines.push(`| ${b.label}${flag} | ${b.value}/10 | ${b.weight} | -${b.lost} |`);
  }
  lines.push('');
  if (result.weakest) {
    lines.push(`**Weakest: ${result.weakest.label}** (-${result.weakest.lost} points)`);
    lines.push(`Ask: ${result.weakest.asks}`);
    if (result.weakest.note) lines.push(`Why: ${result.weakest.note}`);
  }
  return lines.join('\n');
}

module.exports = {
  PARAMETERS,
  byKey,
  score,
  fromEvidence,
  formatCard,
  UNBACKED_CAP,
  TIER_EXPECTED_TOOLS,
  TOOLS_PER_FILE,
};
