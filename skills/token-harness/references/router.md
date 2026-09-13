# Router

Classifies a prompt into a tier and maps it to the cheapest model that can do it
correctly. A weighted keyword and structural heuristic, corrected by two evidence
sources. Not a learned model — `confidence` is distance from a tier boundary, not
a calibrated probability.

## Tiers

| Tier | Model | Agent param |
|---|---|---|
| trivial | claude-haiku-4-5-20251001 | `haiku` |
| simple | claude-haiku-4-5-20251001 | `haiku` |
| moderate | claude-sonnet-5 | `sonnet` |
| complex | claude-opus-5 | `opus` |

## Signals

Base score 2, then weighted matches:

| Signal | W | Examples |
|---|---:|---|
| trivial-edit | -3 | typo, rename, format, bump version |
| conversational | -3 | rate, score, is it, done, redeployed |
| mechanical | -2 | add a field, change the color |
| lookup | -1 | where is, show me, grep |
| scope | +2 | across the codebase, every file |
| reasoning | +3 | why does, how should, tradeoff |
| deep-engineering | +4 | architect, refactor, race condition, security |
| open-ended-work | +5 | continue, go on, start building, try again |
| escalate | +5 | carefully, production, do not break |

Plus structural terms: length, numbered lists, multiple questions.

Bands: `<=0 trivial`, `<=2 simple`, `<=6 moderate`, `>6 complex`.

### Why `open-ended-work` is weighted highest

Backtesting found short continuation orders trigger the *largest* tasks in the
corpus — up to 36 edits across 15 files. Brevity there means unbounded scope, not
small scope. Without this signal, under-routing hit 35% with 14 severe cases.

## Repo blast radius

A prompt naming a file is scored against that file's real facts, not just its
wording:

| Condition | Adds |
|---|---:|
| file > 500 lines | +2 |
| file > 200 lines | +1 |
| > 10 importers | +2 |
| > 3 importers | +1 |
| more than 2 files named | +1 |

So "fix a typo in `README.md`" and "fix a typo in `core.js`" score differently
even though the sentences match.

## Observed neighbours

Past turns resembling this prompt, with what they actually cost, are blended
50/50 with the heuristic. Fewer than two samples is treated as noise and ignored.

## Cost model

The naive comparison — both paths at full input rate — is wrong. The session's
context is prompt-cached (~0.1x input); a subagent starts cold and pays full rate
for whatever context you re-explain.

```
inline   = cacheRead(cached) + input(fresh) + output   on the session model
delegate = input(handoff) + output                     on the sub model, cold
```

`delegate` is gated on economics, not just tier, with a 15% margin so a rounding-
error saving does not justify a round trip.

**Counter-intuitive:** a warm cache narrows the gap rather than reversing it.
Opus 5 costs 5x Haiku 4.5 on both input and output, so a typo fix (15k context,
2k output, 4k handoff) saves 88.8% cold, 84.3% with 8k cached and 77.4% with 14k
cached. The verdict only flips to inline when a
large handoff meets a tiny output.

## Measured accuracy

Against 162 real transcript turns (72.6% on the first 117 — the wider sample is worse):

```
correct delegate/keep decision: 68.5%
false delegate:  20.4%   <- sent real work to a weak model
missed saving:   11.1%   <- paid too much, harmless
exact tier match: 35.8%  |  within one tier: 79.6%
```

False delegation is the costly error and the biggest open gap in the router.

Tier accuracy overstates harm: trivial/simple confusion is free because both
route to haiku. Judge the binary decision.
