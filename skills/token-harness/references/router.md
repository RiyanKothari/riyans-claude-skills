# Router

Classifies a prompt into a tier and maps it to the cheapest model that can do it
correctly. A weighted keyword and structural heuristic, corrected by two evidence
sources. Not a learned model — `confidence` is distance from a tier boundary, not
a calibrated probability.

## Tiers and what is actually routed

| Tier | Cheapest capable model | Routed automatically? |
|---|---|---|
| trivial | Haiku 4.5 | Yes, at score -2 or lower: `delegate -> haiku` (`rc-haiku`) |
| simple | Haiku 4.5 | No: a "simple" rating is always a low-confidence guess |
| moderate | Sonnet 5 | No: wording cannot tell it from complex, so `/model sonnet` is suggested from measured turns |
| complex | Opus 5 | Up only: a Haiku or Sonnet session hands reasoning-heavy work to `rc-opus` |

### Why delegation is a score threshold

On 143 real turns that edited or ran something, delegating every trivial/simple
prediction sent real work to Haiku 29.4% of the time. All 42 of those false
delegations had confidence below 0.34, and 41 were rated "simple": vague work
orders like "make it better", "improve it" and "go", which read short but are not
small. Requiring score -2 or lower gave 0 false delegations in that sample and
73.4% correct decisions instead of 62.9%, at the cost of more missed savings. Only
9 turns in the sample met the bar, so treat the precision as strong but not proven.

### Why Sonnet is suggested, not delegated

Of 29 prompts predicted "moderate", 17 turned out complex, so delegating them to
Sonnet on wording would under-route most of the time. What the session actually did
is reliable: when its last 6 completed turns on Opus or Fable were all small, and at
least 3 were real edits or commands, the hook tells the user once that `/model
sonnet` or `/model opusplan` would handle the stretch for about 60% less.

### Models never routed to

Opus 4.6–4.8 cost the same as Opus 5 and Sonnet 4.6 costs more than Sonnet 5, so an
older version is never the cheapest adequate choice. Fable costs 2x Opus and is never
chosen automatically.

### Follow-through

Before the directive format, the advisory router line was attached to 9 real turns
and acted on in none, and 7 of those 9 would have been wrong. `rcskills backtest`
reports how often routed turns actually called the named subagent.

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

Against 189 real transcript turns, headlined on the 143 that edited or ran
something (a question answered with no tools has nothing to hand a subagent):

```
turns that did work:  correct 73.4%   false delegate 0 (0%)   missed saving 26.6%   delegated 9, precision 100%
every turn:           correct 60.3%   false delegate 0 (0%)   missed saving 39.7%
exact tier match: 34.9%  |  within one tier: 76.2%
follow-through (before the directive format): 8 routed turns, 0 followed, 0 subagent calls
```

Missed savings are now the open gap: small tasks whose prompts carry no cheap signal
("updated api", "failed", pasted credentials) stay on the session model.

Tier accuracy overstates harm: trivial/simple confusion is free because both
route to haiku. Judge the binary decision.
