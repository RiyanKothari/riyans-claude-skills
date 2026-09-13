'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  score, fromEvidence, formatCard, PARAMETERS, UNBACKED_CAP, TIER_EXPECTED_TOOLS,
} = require('./rubric.cjs');

test('parameters are weighted to exactly 100', () => {
  assert.strictEqual(PARAMETERS.reduce((a, p) => a + p.weight, 0), 100);
});

test('there are 6-7 parameters', () => {
  assert.ok(PARAMETERS.length >= 6 && PARAMETERS.length <= 7, `got ${PARAMETERS.length}`);
});

test('a perfect evidence-backed run scores near 100', () => {
  const r = score({
    scopeFit: 10,
    honesty: 10,
    completeness: 10,
    evidence: {
      testsPass: 79, testsTotal: 79, verifyRan: true, coveragePct: 100,
      testsAdded: 6, docsUpdated: true, toolCount: 10, tier: 'moderate',
    },
  });
  assert.ok(r.total > 95, `got ${r.total}`);
  assert.strictEqual(r.cappedCount, 0, 'a fully evidenced run caps nothing');
});

test('claiming correctness without running tests is capped', () => {
  const claimed = score({ correctness: 10, evidence: {} });
  const backed = score({ evidence: { testsPass: 10, testsTotal: 10 } });
  const c = claimed.breakdown.find((b) => b.key === 'correctness');
  const b = backed.breakdown.find((b2) => b2.key === 'correctness');
  assert.ok(c);
  assert.ok(b);
  assert.strictEqual(c.value, UNBACKED_CAP);
  assert.ok(c.capped);
  assert.strictEqual(b.value, 10);
  assert.ok(!b.capped);
});

test('a single failing test caps correctness at half marks', () => {
  // Regression: 217/218 scored 10/10 on a commit that broke CI.
  const r = score({ evidence: { testsPass: 217, testsTotal: 218 } });
  const c = r.breakdown.find((b) => b.key === 'correctness');
  assert.ok(c);
  assert.ok(c.value <= 5, `a red suite scored ${c.value}/10`);
});

test('failing tests drag correctness down proportionally', () => {
  const r = score({ evidence: { testsPass: 5, testsTotal: 10 } });
  const c = r.breakdown.find((b) => b.key === 'correctness');
  assert.ok(c);
  assert.strictEqual(c.value, 5);
});

test('unbacked claims are counted so inflation is visible', () => {
  const r = score({ correctness: 10, verification: 10, durability: 10, evidence: {} });
  assert.strictEqual(r.cappedCount, 3);
});

test('weakest is the biggest weighted loss, not the lowest raw score', () => {
  const r = score({
    scopeFit: 6,        // weight 14 -> loses 5.6
    completeness: 3,    // weight 10 -> loses 7.0
    efficiency: 10,
    honesty: 10,
    evidence: { testsPass: 10, testsTotal: 10, verifyRan: true, coveragePct: 100, testsAdded: 6, docsUpdated: true },
  });
  assert.ok(r.weakest);
  assert.strictEqual(r.weakest.key, 'completeness');
});

test('a mediocre score on a heavy parameter outranks a bad one on a light parameter', () => {
  const r = score({
    correctness: 0,
    scopeFit: 10,
    efficiency: 10,
    honesty: 10,
    completeness: 5,
    evidence: { verifyRan: true, coveragePct: 100, testsAdded: 6, docsUpdated: true },
  });
  assert.ok(r.weakest);
  assert.strictEqual(r.weakest.key, 'correctness');
});

test('fromEvidence leaves unmeasured parameters undefined', () => {
  const ev = fromEvidence({});
  assert.strictEqual(ev.correctness, undefined);
  assert.strictEqual(ev.verification, undefined);
  assert.strictEqual(ev.durability, undefined);
});

test('verification rises with coverage once the suite has run', () => {
  const low = fromEvidence({ verifyRan: true, coveragePct: 10 });
  const high = fromEvidence({ verifyRan: true, coveragePct: 95 });
  assert.ok(high.verification > low.verification);
});

test('out-of-range and garbage inputs are clamped, not thrown', () => {
  const r = score({ scopeFit: 99, efficiency: -5, honesty: 'abc' });
  const s = r.breakdown.find((b) => b.key === 'scopeFit');
  const e = r.breakdown.find((b) => b.key === 'efficiency');
  const h = r.breakdown.find((b) => b.key === 'honesty');
  assert.ok(s && e && h);
  assert.strictEqual(s.value, 10);
  assert.strictEqual(e.value, 0);
  assert.strictEqual(h.value, 0);
});

test('an empty scorecard scores zero rather than defaulting high', () => {
  assert.strictEqual(score({}).total, 0);
});

test('a turn at its tier baseline scores full efficiency', () => {
  const ev = fromEvidence({ toolCount: TIER_EXPECTED_TOOLS.moderate, tier: 'moderate' });
  assert.strictEqual(ev.efficiency, 10);
  assert.ok(ev.efficiencyBacked);
});

test('coming in under the baseline is not penalised', () => {
  const ev = fromEvidence({ toolCount: 1, tier: 'complex' });
  assert.strictEqual(ev.efficiency, 10);
});

test('thrash is detected: double the expected tools halves efficiency', () => {
  const ev = fromEvidence({ toolCount: TIER_EXPECTED_TOOLS.simple * 2, tier: 'simple' });
  assert.strictEqual(ev.efficiency, 5);
});

test('extreme thrash bottoms out at zero rather than going negative', () => {
  const ev = fromEvidence({ toolCount: TIER_EXPECTED_TOOLS.trivial * 20, tier: 'trivial' });
  assert.strictEqual(ev.efficiency, 0);
});

test('efficiency claimed without tool evidence is capped', () => {
  const r = score({ efficiency: 10, evidence: {} });
  const e = r.breakdown.find((b) => b.key === 'efficiency');
  assert.ok(e);
  assert.strictEqual(e.value, UNBACKED_CAP);
  assert.ok(e.capped);
});

test('an unknown tier leaves efficiency unbacked rather than guessing', () => {
  const ev = fromEvidence({ toolCount: 5, tier: 'nonsense' });
  assert.strictEqual(ev.efficiency, undefined);
});

test('four of seven parameters are now evidence-gated', () => {
  const gated = PARAMETERS.filter((p) => p.evidence).map((p) => p.key);
  assert.deepStrictEqual(
    gated.sort(),
    ['correctness', 'durability', 'efficiency', 'verification'],
  );
});

test('the card renders the weakest link and its question', () => {
  const card = formatCard(
    score({
      completeness: 2,
      scopeFit: 10,
      efficiency: 10,
      honesty: 10,
      notes: { completeness: 'left a gap' },
      evidence: {
        testsPass: 10, testsTotal: 10, verifyRan: true,
        coveragePct: 100, testsAdded: 6, docsUpdated: true,
      },
    }),
    'T',
  );
  assert.match(card, /Weakest/);
  assert.match(card, /left a gap/);
});
