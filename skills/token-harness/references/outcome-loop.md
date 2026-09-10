# Outcome loop

Routing advice is worthless if nothing checks whether it was right. Claude Code's
own transcripts are a free labelled dataset: every past turn records what was
asked and what it actually cost.

## Where the data is

`~/.claude/projects/<project>/<session>.jsonl`, one JSON object per line.

A genuine human turn is `type: "user"` **and** `promptSource` set **and**
`origin.kind === "human"`. Everything else arriving as `type: "user"` is a tool
result, hook injection or continuation — excluding these is the whole trick.

Tool calls follow in `type: "assistant"` lines as `content[].tool_use`, each with
`name` and `input`. Attributing those to the preceding human turn yields
`(prompt -> what it actually cost)` pairs.

## Scoring what happened

Deliberately coarse — the signal is noisy, so four buckets is all it honestly
supports:

```
files == 0 && effort <= 2                    -> trivial
files <= 1 && edits <= 2 && effort <= 5      -> simple
files <= 3 && effort <= 14 && reads <= 12    -> moderate
otherwise                                     -> complex
```

where `effort = edits + commands`.

## Two hook modes, not three

```
recall   (UserPromptSubmit)  start turn, surface memory + routing
finalize (Stop)              derive the turn from the transcript, store it
```

There was a third on PostToolUse counting tool calls live. Measurement killed it:
bare `node` startup is **166ms** while the whole memory operation is ~0ms within
noise, and real turns average **12.6 tool calls**.

```
old: 1 recall + 12.6 observe + 1 finalize = 14.6 spawns/turn
new: 1 recall + 1 finalize               =  2   spawns/turn
```

The transcript already held the same facts. **Never put bookkeeping on
PostToolUse** — it multiplies by tool count.

## Backtesting

```bash
npm run backtest          # accuracy against real history
npm run backtest -- --rows  # per-turn detail
npm run seed              # rebuild the neighbour corpus from transcripts
```

Seeding from history means the neighbour corpus starts warm, not cold.

## How to retune honestly

1. Run the backtest and read the **confusion matrix**, not the headline.
2. Find the dominant error cell.
3. Change one signal.
4. Re-run and check that under-routing did not rise while over-routing fell.

Under- and over-routing are not symmetric. Predicting too cheap sends real work
to a weak model; predicting too rich only wastes money. Watch `severeUnder`.

Stop tuning when changes stop moving the binary metric. Fitting further on ~100
turns is overfitting.
