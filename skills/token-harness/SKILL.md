---
name: token-harness
description: Cut Claude Code token cost through model-tier routing, budget-capped memory recall, and evidence-gated self-scoring. Use whenever a [router], [cache] or [next] line appears in the conversation, when the user mentions cost, tokens, spend, context size, caching, /compact or which model to use, or when deciding whether to delegate work to a cheaper model.
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

`rcskills` is on the shell PATH when installed as a plugin, and from any project
once linked (`npm link` in the harness repo).
Inside the harness repo, `npm run <tool> --` does the same thing.

## Core rules

**1. Reduce the work before choosing a model.** Walk the reuse ladder first —
does this need to exist / already in the codebase / stdlib / platform / an
installed dependency / one line / only then write it. The cheapest token is the
one never generated. Never trade away security or data-loss handling to shorten
code; this is reuse, not code golf.

**2. Act on the router, and let evidence pick the model.**
A `[router] delegate -> haiku` line is an instruction: call the Agent tool with the
named subagent (`rc-haiku`, or `rcskills:rc-haiku` in a plugin install; pinned to Haiku 4.5) and a self-contained brief — files,
exact change, verifying command — then check what it did. `escalate -> opus` hands
the reasoning-heavy core to `rc-opus` when the session runs a weaker model. The
router delegates down only on clear cheap evidence (score -2 or lower): vague work
orders like "make it better" read short but are not small. Moderate work is never
delegated on wording alone, because wording cannot tell it from complex. Older Opus and
Sonnet versions are never the cheapest adequate choice and are never routed to.

**2b. Every message on the model its work needs.** The hook reads each message before it
runs. Small work on Opus goes to Sonnet 5.5 ($2/$10) after 3 measured small turns, when
the message is not complex, reasoning-heavy or a new work order; replayed over 348 real
turns, that ran complex work on Sonnet 2% of the time, against 29% for judging by the
prompt alone — `rcskills backtest` re-measures it. Opus work on Sonnet goes to Opus 5.5
the moment it arrives. An older, dearer model moves to the newest of its family (Opus 5,
4.8, 4.7 → Opus 5.5), which never costs quality. The first advice on a model holds the
message once, at no token cost, with the command and the message handed back; every
later reply ends with the current `[next]` line, so each message is advised on its own.
Step down as `/compact` first, while still on the old model, then `/model`: the cache
belongs to one model, so the re-cache is charged on the small compacted result. Reasoning
is bound to the exact model that wrote it, so the switch hook saves the readable
reasoning, open tasks and files, and the next prompt shows a `[handoff]` line: continue
from it. The best model of each family comes from the price table. Never switch the
model for the user; Claude Code refuses a session re-pricing itself.

**3. Never dump memory into context.** Query it. Recall is BM25-ranked and hard-
capped by a token budget, so cost cannot grow with store size. Unused notes decay
and self-prune; retrieved notes strengthen. Pin only standing policy.

**4. Score on evidence, not opinion.** Four of seven scorecard parameters cap at
5/10 without real measurement. Report the total, name the weakest parameter and
why, then fix it or declare it an open gap.

**5. Never put bookkeeping on PostToolUse.** It spawns one process per tool call
(~166ms each; real turns average 12.6 tools). Derive from the transcript at Stop.

**6. Audit what is always loaded.** CLAUDE.md and MCP schemas are paid on every
single request — an unused MCP server costs its whole schema forever. Skills are
paid only when they load, so push detail into `references/`. `npm run audit`
ranks offenders by that leverage.

**7. Copy every `[next]` line, word for word, as the last line of the reply.** Only
the user can run /compact or /model, so the hook writes the finished line — the
command, what to keep, and what it costs — and it must reach them every time. One
per reply at most. The compaction point is worked out per session: the lower of where
re-reading costs $0.15 per request and 40% of the model's window, brought forward at a
natural break or fast growth, pushed back mid-task. Tune it with
`rcskills config compact <on|off|dynamic|tokens>` and `compact-budget <usd>`.

## Details on demand

Load only what the current task needs:

- `references/router.md` — tier signals, repo blast radius, cache-aware cost model
- `references/memory.md` — decay math, budgeted recall, fixed core
- `references/outcome-loop.md` — transcript parsing, backtesting, how to retune
- `references/scorecard.md` — the seven parameters and their evidence gates
- `references/install.md` — harness install, profiles, doctor, uninstall

## Verify before claiming

`npm run verify` (typecheck + tests) must pass before reporting any of this as
working. `npm run backtest` must not regress after touching the router.
