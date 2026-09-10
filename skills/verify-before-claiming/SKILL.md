---
name: verify-before-claiming
description: Discipline for proving work rather than asserting it — running the thing, measuring before optimising, and reporting honestly when results are bad. Use before saying something works, before optimising anything, when reporting a result or score, and whenever tempted to describe intent as outcome.
---

# Verify Before Claiming

## Run it, then say it

"It works" without an execution is a guess wearing a confident tone. Before
reporting anything as done: run the tests, run the command, load the page.

Build the gate into the tooling so discipline is not required. A scorecard
whose correctness score **caps at 5/10 without a real test run** cannot be
talked past. Self-reported flags are the thing to avoid — derive evidence from
the run, the transcript, or the filesystem.

## Measure before optimising

Guesses about cost are usually wrong, and optimising the wrong thing wastes the
effort twice.

A memory hook here looked expensive, so the obvious move was to optimise the
index. Measuring first killed that plan:

```
bare node startup:      166 ms
full memory load + BM25:  ~0 ms   (within noise)
```

The work was free; the *process spawn* was the entire cost. The real fix was
removing a hook that fired once per tool call — 14.6 spawns per turn down to 2.
No amount of index tuning would have found that.

## When a number looks bad, check the measurement first

A durability score read 0/10 on a turn that added thirteen tests. The work was
fine; nothing was measuring it. A later version used file mtimes and inflated
the same score by counting the *previous* turn's files.

**Check whether the measurement is broken before assuming the work was.**

## Validate against reality, not intuition

A prompt classifier felt accurate. Backtested against 117 real transcript turns
it scored 26.5%, and the confusion matrix showed it labelling almost everything
"moderate". Two data-driven fixes took it to 43.6%.

Where past runs are recorded — transcripts, logs, CI history — that is a free
labelled dataset. Use it instead of trusting the feeling.

## Report honestly

State the number even when it is bad, name the weakest part, and say why. A low
score that names its cause is worth more than a high one that hides it.

If you find a bug in your own work, lead with it. Shipping a known defect
quietly costs far more than the embarrassment of naming it.

## Your own tests are not automatically right

Several failures here were wrong *expectations*, not wrong code. When a test
fails, decide which is wrong before touching either — and never weaken an
assertion just to get green.
