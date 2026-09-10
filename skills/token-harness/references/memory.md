# Memory

A store that forgets what it does not use and cannot blow the context budget by
construction. Plain JSONL plus an in-process index — no embedding API, no daemon,
no native dependency.

## Two tiers

**Fixed core** — injected into every session at SessionStart, unconditionally,
capped at 400 tokens. Carries standing policy across model swaps and context
resets so a fresh session is never blank.

**Per-prompt recall** — BM25-ranked, capped at 350 tokens, silent when nothing
scores.

Both are hard caps. The cost paid is fixed and known regardless of store size.

## Core membership is earned

```
core = pinned OR (uses >= 5 AND baseStrength == max)
```

Pinning is manual and permanent (`--pin`). Everything else graduates on its own
evidence — a note retrieved repeatedly has proven it matters more reliably than
anyone predicting in advance. Pinned always outranks earned; the block is
token-capped either way.

## Decay

```
strength(t) = baseStrength * exp(-ln(2)/halfLife * daysSinceLastUse)
```

Half-life defaults to 30 days, measured from *last use*. Retrieval resets the
clock and adds a small permanent boost, so recall works as spaced repetition.
Records below 0.15 strength and older than 14 days prune themselves. Pinned
records never decay.

## Ranking

BM25 over tokenized text (`k1=1.5`, `b=0.75`), multiplied by `(0.5 + strength)`.
So relevance leads, and among comparably relevant notes the ones you actually use
win.

Tokenizer stems `-ing` / `-ed` / `-s` and collapses the doubled consonant, so
`running` matches `run`. Stopwords dropped.

## Budgeted recall

Results are taken greedily while they fit the budget, then it stops. A note too
large for the remaining budget is skipped rather than truncated — a half-note is
worse than no note.

## Commands

```bash
npm run mem -- add "durable fact" [--pin] [--kind policy]
npm run mem -- recall "question" [--budget 400]
npm run mem -- forget "substring" [--yes]     # dry-run without --yes
npm run mem -- stats
npm run mem -- prune
```

`forget` exists because core records are injected everywhere — a stale one stays
wrong forever unless it can be corrected. It is destructive, so it dry-runs by
default.

## Robustness

Corrupt JSONL lines are skipped on load rather than taking the store down. Adding
identical text reinforces the existing record instead of duplicating it.
