# Riyan's Claude Skills — working rules

This repo is a Claude Code harness: cache-lapse warnings, model-tier routing,
bounded memory, ralph loops and an evidence-gated scorecard. It ships as a plugin
and as a settings install. Everything here is a rule this project earned.

## Rules

- Do what has been asked; nothing more, nothing less
- NEVER create files unless absolutely necessary — prefer editing existing files
- NEVER create documentation files unless explicitly requested
- NEVER save working files or tests to root — use `tools/`, `skills/`, `scripts/`
- ALWAYS read a file before editing it
- NEVER commit secrets, credentials, or .env files
- NEVER commit `.claude/memory/` — it is built from real prompts and is user data
- NEVER add a `Co-Authored-By` trailer to user commits unless this project's
  `.claude/settings.json` has `attribution.commit` set (#2078). The Bash tool
  suggests one in its default commit template — ignore it. That trailer is
  semantic authorship attribution under git/GitHub convention; the tool is the
  facilitator, not a co-author.
- Keep files under 500 lines
- Validate input at system boundaries

## Layout

| Path | What it is |
|---|---|
| `bin/harness.js` | the `rcskills` CLI: install, doctor, uninstall, and every tool |
| `.claude/helpers/learning-hook.cjs` | every hook mode: `core`, `recall`, `loop`, `switch` |
| `hooks/hooks.json` | how the plugin wires those modes (uses `${CLAUDE_PLUGIN_ROOT}`) |
| `tools/` | the libraries and their tests, side by side |
| `skills/` | the skills, linted like code |
| `scripts/plugin-smoke.sh` | installs this checkout as a real plugin and proves each hook |

## Verify before claiming

```bash
npm run verify
```

`tsc` typecheck, `npm run lint:skills` (frontmatter, triggers, links, encoding,
credentials), then `node --test`. All of it must pass before saying anything works.

CI runs that on Linux and Windows × Node 18/20/22, plus: an install smoke test
that executes the installed hooks and requires their output, a tarball check, the
README's `npx … spend` one-liner fetched from GitHub on three OSes, and
`plugin-smoke.sh` on three OSes.

Two rules that cost this project real time:

- **Prove a hook by its output, never by its exit code.** Claude Code runs Windows
  hooks through Git Bash, where a `cmd /c` hook silently does nothing and exits 0.
  Hook commands must be shell-neutral: `node "path/with/forward/slashes" mode`.
- **`set -e` is ignored at the top level of a Bash tool command.** Never gate a
  commit or push on it — use explicit `|| exit 1`, or require `fail 0` in captured
  output.

## Efficiency (what the scorecard measures, and how to earn it)

A turn is allowed the larger of its tier baseline and 4 tool calls per distinct
file it touched — the median of 163 real turns. Going over means round trips that
bought nothing. One audited turn here spent 105 calls on 11 files (9.5 each):
75 were Bash, 24 were exact repeats, including 7 separate edits to one file, 6 to
another, and 5 full `npm run verify` runs.

- Make independent calls in one message. Serial one-line greps are the main leak.
- Decide every change to a file, then make them; do not edit, look, edit again.
- Run `npm run verify` once per logical batch, not after each edit. It is 23s.
- Never re-read a file already read this turn, and never re-read a file just
  edited — Edit fails loudly if it did not apply.

## Self-scorecard (run after every non-trivial task, without being asked)

```bash
npm run scorecard -- score --title "what I did" --scopeFit 8 --scopeFit-why "reason"
npm run scorecard -- trend
```

Seven parameters weighted to 100. Four — correctness, verification, durability,
efficiency — are evidence-gated and cap at 5/10 without real measurement, no
matter what is claimed. Durability reads the transcript, so shipping code without
tests or docs shows up in the same turn.

Report the score honestly even when bad, name the **weakest parameter** and why,
then fix it or declare it an open gap. `trend` flags a recurring weak spot — that
is a habit, not an accident. Full rubric: `skills/token-harness/references/scorecard.md`.

## Reuse ladder (run before writing any code)

Walk down and stop at the first rung that works:

1. Does this need to exist at all?
2. Already in this codebase?
3. Standard library?
4. Native platform feature?
5. Already-installed dependency?
6. Can it be one line?
7. Only then: minimum viable implementation

Run the ladder *after* understanding the problem, not instead of it — read the
code the change touches and trace the real flow first.

Never trade away trust-boundary validation, data-loss handling, security or
accessibility to shorten code. This is a reuse ladder, not code golf.

The cheapest token is the one never generated; this compounds with the routing
below, which only makes the remaining work cheaper.

## Model-tier routing

Pick the cheapest model that can do the task correctly. Check any prompt with
`npm run route -- "<prompt>"`.

| Router line | Action |
|---|---|
| `[router] delegate -> haiku` | Agent tool, `subagent_type: "rc-haiku"`, a self-contained brief (files, exact change, verify command); check its result |
| `[router] escalate -> opus` | Hand the reasoning-heavy core to `rc-opus`; keep the mechanical parts inline |
| `/model sonnet` suggestion | Tell the user in one sentence; the session model is theirs to change |
| no line | Handle inline |

- `delegate -> haiku` fires only on clear cheap evidence (router score -2 or lower)
  **and** when it pays: a subagent carries ~56k tokens of fixed context, so it only
  beats inline work in long sessions (on Opus a 2-call edit pays past ~335k tokens,
  ~99k if a subagent ran in the last 5 minutes; a loss in a fresh session).
- Stay inline only if the brief would need this conversation's history.
- Never downgrade an ambiguous task: vague work orders ("make it better") are not small.
- Never route to older model versions: they cost the same or more and are weaker.
- `npm run backtest` reports routing accuracy and how often routed turns were
  actually delegated.

## Memory (fixed core + bounded recall)

Two tiers, both capped so neither can bloat context.

**Fixed core** — injected into *every* session at SessionStart, capped at 400
tokens. It carries standing policy across model swaps and context resets.

- Pinned records are always core (`npm run mem -- add "..." --pin`).
- A record retrieved 5+ times that reaches full strength graduates into core on its
  own evidence. The core curates itself; do not hand-pin what usage proves.

**Per-prompt recall** — BM25-ranked, capped at 350 tokens, silent when nothing
scores. Query it; do not dump memory into context.

```bash
npm run mem -- recall "<what you need to know>" --budget 400
npm run mem -- add "<durable fact worth keeping>" [--pin]
```

Memories decay on an exponential half-life and strengthen when retrieved. Unused
ones prune themselves; `--pin` exempts a fact from decay. Pin only standing policy.

Recall before starting non-trivial work; add a fact when a session produces durable
knowledge the code does not already state. A project's memory lives under
`~/.claude/token-harness`, never in the repo.

## Prices

`tools/model-router/cost.cjs` holds Anthropic's list prices and context windows.
It is the single source of truth for every dollar figure the harness prints. When
prices change, edit that table and the date in its comment — nothing else.
