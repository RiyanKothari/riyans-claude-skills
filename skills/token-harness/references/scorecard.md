# Scorecard

Seven parameters weighted to 100, run after every non-trivial task. The point is
not the number — it is that **four of the seven cannot be inflated**.

| Parameter | W | Gated by |
|---|---:|---|
| Correctness | 20 | test pass rate |
| Verification | 18 | suite actually running, plus coverage |
| Durability | 14 | share of changed modules a changed test names (6), docs edited (4) |
| Scope fit | 14 | self-rated |
| Efficiency | 12 | tool count vs the work the turn did |
| Honesty | 12 | self-rated |
| Completeness | 10 | self-rated |

## The anti-inflation gate

A gated parameter caps at **5/10** without evidence. "It works" with no test run
cannot outscore a verified result. `cappedCount` reports how many claims were
capped, so inflation is visible rather than silent.

Evidence is gathered by *running the suite*, not by asking how it went. One
coverage run supplies both the pass/fail counts and the coverage number —
`node --test --experimental-test-coverage` emits them together.

## Efficiency is measured, not felt

Tool count against what the turn is allowed, which is the larger of the tier
baseline and the measured cost of touching that many files:

```
tier floor:  trivial 2   simple 5   moderate 14   complex 30
per file:    4 tool calls
allowed   =  max(tier floor, 4 x distinct files)
ratio <= 1        -> 10/10
double allowed    ->  5/10
```

Coming in under the allowance is full marks, never a bonus. This detects *thrash*
— retries, flailing, dead ends — which is what inefficiency actually looks like.

The per-file number is the median of 163 real turns that touched at least one
file (p25 2.5, p50 4.0, p75 7.0, p90 11.0). It is the stable quantity: per-turn
cost varies thirtyfold within the complex tier alone (p50 29 tools, p90 74, max
150) while per-file cost barely moves between tiers — 3.0 simple, 4.0 moderate,
4.1 complex. The flat tier baseline therefore scored *how much was asked for*
rather than how it was done: an audit touching 16 files scored 0/10 while a
two-file turn burning the same calls scored the same. The floor keeps that case
honest — 100 calls on two files is still 0/10 — and the allowance never drops
below the tier baseline, so a turn that touched no files is judged exactly as
before.

## Weakest link

The weakest parameter is the biggest **weighted** loss, not the lowest raw score.
A 6/10 on a weight-20 parameter outranks a 3/10 on a weight-10 one, because it is
bleeding more points.

`npm run scorecard -- trend` flags a parameter that keeps coming up weakest —
that is a habit to fix, not an accident to excuse. The recurring weak spot is
carried into every session by the core hook, so the pattern follows you instead
of resetting.

## Reporting rules

- Report the score honestly even when it is bad. A low score that names its cause
  is worth more than a high one that hides it.
- State the weakest parameter, say *why*, then fix it in the same turn or name it
  explicitly as an open gap.
- Skip the scorecard for genuinely trivial turns — running it on a one-line answer
  is ceremony, not rigour.

## When a parameter scores badly

Check whether the **measurement** is broken before assuming the work was. This
rubric has caught its own author three times: durability once scored 0/10 because
nothing measured it; a later mtime-based version inflated it by counting the
previous turn's work; and turn evidence was read from the newest transcript in
*any* project, so a turn that shipped three test files and a SKILL.md scored
durability 0 (and inflated efficiency) whenever another session wrote last. That
last one showed up as "durability, recurring weak spot (15x)" — a habit that was
really a measurement bug. Evidence now comes only from this session's own
transcript. The fix every time was better measurement, not a self-reported flag.
