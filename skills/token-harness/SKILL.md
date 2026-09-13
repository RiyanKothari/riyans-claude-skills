---
name: token-harness
description: Cut Claude Code token cost through model-tier routing, budget-capped memory recall, and evidence-gated self-scoring. Use when API cost matters, when deciding whether to delegate work to a cheaper model, when you need memory that survives across sessions without bloating context, or when auditing what is eating the context window.
---

# Token Harness

Four mechanisms that reduce cost without reducing capability. Each is measured,
not asserted.

## When to reach for which

| Situation | Use | Command |
|---|---|---|
| About to start a task | Router | `rcskills route "<task>"` |
| Need past context | Memory | `rcskills mem recall "<question>"` |
| Finished a task | Scorecard | `rcskills scorecard score --title "..."` |
| Doubting the router | Backtest | `rcskills backtest` |
| Context feels bloated | Audit | `rcskills audit` |

`rcskills` works from any project once linked (`npm link` in the harness repo).
Inside the harness repo, `npm run <tool> --` does the same thing.

## Core rules

**1. Reduce the work before choosing a model.** Walk the reuse ladder first â€”
does this need to exist / already in the codebase / stdlib / platform / an
installed dependency / one line / only then write it. The cheapest token is the
one never generated. Never trade away security or data-loss handling to shorten
code; this is reuse, not code golf.

**2. Match model to task, and escalate when unsure.**
`trivial|simple â†’ haiku`, `moderate â†’ sonnet`, `complex â†’ opus`.
Delegate via the Agent tool's `model` parameter. When confidence is low, escalate
a tier â€” a weak model on a hard task costs a retry, which exceeds the saving.
Absence of evidence is not ambiguity: a short prompt with no complexity signal is
conversational, but a short *open-ended work order* ("continue", "go on") is the
opposite and must escalate.

**3. Never dump memory into context.** Query it. Recall is BM25-ranked and hard-
capped by a token budget, so cost cannot grow with store size. Unused notes decay
and self-prune; retrieved notes strengthen. Pin only standing policy.

**4. Score on evidence, not opinion.** Four of seven scorecard parameters cap at
5/10 without real measurement. Report the total, name the weakest parameter and
why, then fix it or declare it an open gap.

**5. Never put bookkeeping on PostToolUse.** It spawns one process per tool call
(~166ms each; real turns average 12.6 tools). Derive from the transcript at Stop.

**6. Audit what is always loaded.** CLAUDE.md and MCP schemas are paid on every
single request â€” an unused MCP server costs its whole schema forever. Skills are
paid only when they load, so push detail into `references/`. `npm run audit`
ranks offenders by that leverage.

**7. Compact at phase boundaries, never mid-implementation.** Researchâ†’plan,
planâ†’build, or after a failed approach. Write the plan to a file first: task
lists do not survive `/compact`.

## Details on demand

Load only what the current task needs:

- `references/router.md` â€” tier signals, repo blast radius, cache-aware cost model
- `references/memory.md` â€” decay math, budgeted recall, fixed core
- `references/outcome-loop.md` â€” transcript parsing, backtesting, how to retune
- `references/scorecard.md` â€” the seven parameters and their evidence gates
- `references/install.md` â€” harness install, profiles, doctor, uninstall

## Verify before claiming

`npm run verify` (typecheck + tests) must pass before reporting any of this as
working. `npm run backtest` must not regress after touching the router.
