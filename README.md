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
| [ralph-loop](skills/ralph-loop/) | Re-feed one prompt at every stop until a completion promise is true or a hard cap is hit |

Each is a standalone `SKILL.md`. Detail lives in `references/` and loads only
when needed, so a session that wants routing never pays for the rest.

### Skills are linted like code

Prose fails silently — a malformed frontmatter name stops a skill loading and
nothing tells you. `npm run lint:skills` runs as part of `npm run verify` and
checks every skill for:

- frontmatter that parses, with `name` matching the directory
- a description rich enough to trigger, that actually states *when* to use it
- `references/` links that resolve
- mojibake from a bad encoding round-trip
- credential-shaped strings

It caught a real bug on its first run: a bulk rename had rewritten
`token-harness`'s frontmatter name, which would have stopped it loading.

## Profiles

Each hook is a node process (~166 ms measured), so this is a real cost choice.

| Profile | Hooks | Per-turn | Use when |
|---|---|---|---|
| `minimal` | none | zero | You want the skills and CLI only |
| `standard` | core, recall, loop | ~2 spawns | Default. Memory and `/ralph-loop` work automatically |
| `strict` | + finalize | ~3 spawns | You want the router to learn from outcomes |

The `loop` hook runs at every stop but prints nothing and costs no tokens unless
this session started a loop.

No profile registers a `PostToolUse` hook. That absence is load-bearing and has
a test asserting it.

## Commands

From any project, once the CLI is linked (`npm link` in this repo):

```bash
rcskills route "your task"          # which model can do this?
rcskills mem recall "question"      # what do we already know?
rcskills audit                      # what is eating my context?
rcskills backtest                   # is the router actually accurate?
rcskills spend                      # where did the money go? (--project <dir>, --json)
rcskills scorecard trend            # am I improving or repeating mistakes?
rcskills loop start 'task' --completion-promise 'DONE' --max-iterations 10
```

To use everything in every project:

```bash
npm link
node bin/harness.js install --profile standard --global
```

Memory and scorecards for any project other than this repo live under
`~/.claude/token-harness/projects/`, never inside the project — memory is built
from your prompts, and must not end up committed to another repository.

## Settings

Compaction prompts are on by default, and the point at which they fire is worked
out per session rather than fixed. It is the lower of two limits:

| Limit | Default | Opus 5 | Sonnet 5 | Haiku 4.5 |
|---|---|---:|---:|---:|
| Re-reading the context costs this per request | $0.15 | 300k | 750k | 1.5M |
| Share of the model's context window | 40% | 400k | 400k | 80k |

The result is then brought forward (x0.75) when the last turn reached a natural
break (committed, pushed, or just answered), pushed back (x1.5) when it left edits
uncommitted, and brought forward again (x0.8) when context is growing more than
50k per message. Once past that point the next message carries a `[context]` line
naming the point and why, asking Claude to suggest `/compact` to you. It repeats
only after another 100k of growth, and resets once you compact.

```bash
rcskills config                         # show current settings
rcskills config compact-budget 0.30     # tolerate pricier sessions
rcskills config compact 250000          # use a fixed threshold instead
rcskills config compact dynamic         # back to per-session
rcskills config compact off             # never prompt
```

### Cache guard

A message sent after the prompt cache expires (an hour idle, by default) makes the
model re-read the whole session at the cache-write rate before doing anything: 677k
tokens on Opus 5 is ~$6.77 for one message. The guard holds the first such message
once and shows the price. `/clear` starts fresh for ~$0.56 and the new session is
given a summary of the old one (recent asks, files edited, last reply, secrets
redacted). Sending the same message again goes through. It stays silent when the
cache is warm, for slash commands, and when a fresh session would save less than
the budget.

```bash
rcskills config cache-guard 1.00        # hold only when /clear saves $1+
rcskills config cache-guard off         # never hold a message
```

Settings live in `~/.claude/token-harness/config.json` and apply to every project.
To change one project only, set `TOKEN_HARNESS_COMPACT` (`on`, `off`, `dynamic`
or a token count) or `TOKEN_HARNESS_CACHE_GUARD` (`on`, `off` or dollars) in the
`env` block of that project's `.claude/settings.json`.

## What the numbers actually are

`rcskills spend` on 2,821 real requests ($854 at list price) across 10 sessions:

```
cache reads    62.4%   re-reading context: compaction prompts target this
cache writes   27.4%
output         10.2%

cache rewrites of already-cached context:
  39  $129.39  15.1%  expired while idle   <- the cache guard holds 32 of these;
                                             /clear on each saves $107.60 (12.6%)
   7   $38.72   4.5%  prefix changed for an unknown reason
   2    $0.96   0.1%  model switched (Claude Code already asks first)
   3    $1.36   0.2%  compaction
```

Only 5 shell outputs ever exceeded 12k characters, so capping command output would
save almost nothing. The measurement said so before anything was built.

Backtested against 189 real transcript turns, 143 of which edited files or ran
commands — the only turns where handing work to a subagent is possible:

```
                        before     now (score -2 or lower)
correct decision:       62.9%      73.4%
false delegate:         29.4%      0%      <- sent real work to a weak model
missed saving:           7.7%      26.6%   <- paid too much, harmless
```

The old rule delegated anything rated trivial or simple. All 42 false delegations
were low-confidence "simple" guesses on vague work orders like "make it better".
Only 9 turns meet the new bar, so the 0% is strong evidence, not proof.

Follow-through is measured too, because advice nobody acts on is worth nothing:
before the directive format, router lines reached 8 turns and were acted on in
none, and no turn in the history called a subagent at all. `rcskills backtest`
reports both numbers.

What a delegation really costs was measured too. A Haiku subagent starts with ~56k
tokens of fixed context and cost $0.088 per small run ($0.035 with a warm cache),
and the parent still spends two requests on it. So delegation loses money in a
fresh session and only pays in long ones: on Opus a two-call edit breaks even at
~335k tokens (~99k while a recent subagent's cache is warm) and saves about 18% at
411k, not the ~89% the first cost model claimed. The router now
prices each prompt against the session's real context and stays silent otherwise.

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
npm run verify        # typecheck + skill lint + 308 tests
npm run lint:skills   # validate every SKILL.md on its own
npm run coverage      # ~94%
```

CI runs the suite on Ubuntu and Windows across Node 18/20/22, plus an install
smoke test that asserts a pre-existing config survives installation.

## License

MIT — see [LICENSE](LICENSE).
