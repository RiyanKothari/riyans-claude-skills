# Riyan's Claude Skills

Skills and a harness for Claude Code. Every rule in here was earned from
something that actually broke or was actually measured — nothing is aspirational.

MIT licensed. No API key, no daemon, no native dependency. Node 18+.

```bash
git clone https://github.com/RiyanKothari/riyans-claude-skills
cd riyans-claude-skills && npm install
node bin/harness.js install --profile standard
node bin/harness.js doctor
```

`--global` installs to `~/.claude` instead of the current project.

## The skills

| Skill | What it is for |
|---|---|
| [token-harness](skills/token-harness/) | Route cheap work to cheap models, bounded memory, outcome learning, self-scoring |
| [verify-before-claiming](skills/verify-before-claiming/) | Prove it ran; measure before optimising; report honestly when results are bad |
| [safe-operations](skills/safe-operations/) | Config writes, deletes, bulk edits, installers — the rules that prevent data loss |
| [secrets-hygiene](skills/secrets-hygiene/) | Redact at write time; derived caches leak too; what to do after a leak |
| [debug-systematically](skills/debug-systematically/) | Probe real state instead of theorising; fix causes, not symptoms |

Each is a standalone `SKILL.md`. Detail lives in `references/` and loads only
when needed, so a session that wants routing never pays for the rest.

## Profiles

Each hook is a node process (~166 ms measured), so this is a real cost choice.

| Profile | Hooks | Per-turn | Use when |
|---|---|---|---|
| `minimal` | none | zero | You want the skills and CLI only |
| `standard` | core, recall | ~1 spawn | Default. Memory works automatically |
| `strict` | + finalize | ~2 spawns | You want the router to learn from outcomes |

No profile registers a `PostToolUse` hook. That absence is load-bearing and has
a test asserting it.

## Commands

```bash
npm run route -- "your task"        # which model can do this?
npm run mem -- recall "question"    # what do we already know?
npm run audit                        # what is eating my context?
npm run backtest                     # is the router actually accurate?
npm run scorecard -- trend           # am I improving or repeating mistakes?
```

## What the numbers actually are

Backtested against 117 real transcript turns:

```
correct delegate/keep decision: 72.6%
false delegate:  14.5%   <- sent real work to a weak model
missed saving:   12.8%   <- paid too much, harmless
```

Tier accuracy is 43.6% and that is the wrong headline — trivial/simple confusion
is free because both route to the same cheap model. Judge the binary decision.

## Design rules worth stealing without installing anything

1. **Measure before optimising.** Bare `node` startup is 166 ms; the whole memory
   operation is ~0 ms. Optimising the index would have been pointless — spawn
   count was the entire cost.
2. **Never put bookkeeping on `PostToolUse`.** It multiplies by tool count (12.6
   average). Derive from the transcript at Stop: 14.6 spawns/turn down to 2.
3. **Absence of evidence is not ambiguity.** Escalating every low-confidence
   prompt collapsed the trivial tier and caused 54.7% over-routing.
4. **Never treat "cannot read" as "empty".** A BOM made `JSON.parse` throw, a
   `catch` returned `{}`, and an installer wrote that over a user's whole config.
5. **Derived data inherits sensitivity.** Redacting a record's text left the
   secret in the search index built from it.
6. **Check the measurement before blaming the work.** A 0/10 score meant nothing
   was measuring, not that nothing was done.

## Development

```bash
npm run verify     # typecheck + 150 tests
npm run coverage   # ~94%
```

CI runs the suite on Ubuntu and Windows across Node 18/20/22, plus an install
smoke test that asserts a pre-existing config survives installation.

## License

MIT — see [LICENSE](LICENSE).
