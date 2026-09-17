# Riyan's Claude Skills

Claude Code skills and hooks that cut what a session costs, and make Claude prove
its work. Every rule was measured on real sessions (2,944 requests, $886) or earned
from something that broke.

MIT licensed. Node 18+. No API key, no daemon, no dependencies.

## What you get

- **No surprise cache bills.** In a large session Claude's reply ends with how long
  the prompt cache stays cheap and what coming back later will cost, and after any
  turn that paid to re-send cached context, the next reply says why and how to avoid it.
- **Cheaper models where they are safe.** Small mechanical work goes to a Haiku
  subagent, but only in sessions long enough for that to cost less. On past
  transcripts (143 turns that edited files or ran commands) it never handed real
  work to a weak model.
- **Memory that cannot bloat.** Standing rules reach every session in 400 tokens or
  less. Each prompt recalls only what scores, capped at 350.
- **`/rcskills:ralph-loop`** keeps Claude working on a task until a completion
  promise is verifiably true, or a hard cap is reached.
- **Discipline skills** that load only when relevant: verify before claiming, safe
  config and delete operations, secrets hygiene, systematic debugging.

## Install

From a terminal:

```bash
claude plugin marketplace add RiyanKothari/riyans-claude-skills
```

```bash
claude plugin install rcskills@riyans-claude-skills
```

Or type `/plugin marketplace add RiyanKothari/riyans-claude-skills` and then
`/plugin install rcskills@riyans-claude-skills` inside Claude Code. Start a new
session afterwards, because hooks load when a session starts.

It adds about 730 tokens per session for the skill and subagent descriptions
(`claude plugin details rcskills@riyans-claude-skills` shows the breakdown); the
hooks cost no model tokens. `rcskills` is on Claude's shell PATH, so you can ask
Claude to run any command below.

Cost notices work on every Claude model from Opus 4 and Sonnet 4 on, including
Bedrock and Vertex model ids, at each model's list price. A release newer than the
price table is priced as its family's newest model until the table catches up.

To remove it: `claude plugin uninstall rcskills@riyans-claude-skills`. Your memory
and scorecards stay in `~/.claude/token-harness`.

<details>
<summary>Install without the plugin system</summary>

```bash
git clone https://github.com/RiyanKothari/riyans-claude-skills
cd riyans-claude-skills && npm link
rcskills install --profile standard --global
rcskills doctor --global
```

Leave out `--global` to install into the current project only. Installed both
ways, the plugin's hooks stand down so nothing runs twice.

</details>

## What you will see

| When | Line | What to do |
|---|---|---|
| A large session, before stepping away | `367k tokens cached. Reply within 30 min to keep it cheap…` | Reply soon, or `/compact` first |
| After a turn that re-sent cached context | `The last turn re-sent 306k already-cached tokens (~$3.06) because…` | Follow the fix it names |
| Context worth compacting | `[context]` line, relayed as a one-sentence `/compact` suggestion | Compact at the next break |
| `/model` re-selecting the model already in use | A confirmation, with the re-cache price | Cancel unless you meant it |
| A new session after `/clear` | `[last session 2h ago]` recent asks, files and last reply | Nothing: Claude has the thread |

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

## Profiles (settings install)

The plugin always runs `standard`. Each hook is a node process (166-650 ms
measured, depending on the machine), so the settings install lets you choose.

| Profile | Hooks | Per-turn | Use when |
|---|---|---|---|
| `minimal` | none | zero | You want the skills and CLI only |
| `standard` | core, recall, loop, switch | ~2 spawns | Default. Memory, cache notices and `/ralph-loop` work automatically |
| `strict` | same hooks; loop also records outcomes | ~2 spawns | You want the router to learn from outcomes |

The `loop` hook runs at every stop and costs no tokens: it feeds a loop's prompt
back only when this session started one, and otherwise may show you a `[cache]`
notice that Claude never sees. `switch` runs only when the model changes.

No profile registers a `PostToolUse` hook. That absence is load-bearing and has
a test asserting it.

## Commands

Claude can run these in any project once the plugin is installed (or after
`npm link` in this repo, for your own terminal):

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

A message sent after the prompt cache lapses makes the model re-read the whole
session at the cache-write rate before doing anything: 677k tokens on Opus 5 is
~$6.77 for one message. The 1-hour cache is not dependable for the full hour either:
2 of 10 real idle gaps of 30-60 minutes rewrote it, against 1 of 70 gaps of 5-30.

So in a session where that would cost $0.50+ more than a fresh one, Claude ends its
reply with:

```
367k tokens cached. Reply within 30 min to keep it cheap; after that your next message
re-sends it all (~$3.67). Stepping away? /compact first, or /clear (~$0.56, keeps a summary).
```

It repeats at most every 15 minutes unless the context grows by 100k, and stays out
of the way when a `/compact` suggestion is already due. After any turn that paid to
re-send cached context, the next reply says what caused it and how to avoid it:

```
The last turn re-sent 306k already-cached tokens (~$3.06) because the cache lapsed
after 4h 54m idle. Fix: run /compact before stepping away.
```

The line goes through Claude's reply because the desktop app does not display a Stop
hook's `systemMessage`. The first version used one; it ran, and nothing appeared.

After `/clear` the new session is handed a summary: recent asks, files edited and the
last reply, with secrets redacted. `/model` re-selecting the model already in use asks
first, because it changes nothing but still re-caches everything.

```bash
rcskills config cache-guard 1.00        # only when /clear would save $1+
rcskills config cache-guard block       # also hold the first message after expiry, once
rcskills config cache-guard off
rcskills config learning on             # record outcomes so the router learns (strict, for plugin installs)
```

Settings live in `~/.claude/token-harness/config.json` and apply to every project.
To change one project only, set `TOKEN_HARNESS_COMPACT` (`on`, `off`, `dynamic`
or a token count) or `TOKEN_HARNESS_CACHE_GUARD` (`on`, `off` or dollars) in the
`env` block of that project's `.claude/settings.json`.

## What the numbers actually are

`rcskills spend` on 2,944 real requests ($886 at list price) across 10 sessions:

```
cache reads    61.7%   re-reading context: compaction prompts target this
cache writes   27.7%
output         10.6%

rewrites of already-cached context, by cause:
  43  $137.26  15.5%  expired while idle               reply line before, explained after
   3   $18.77   2.1%  idle 30-60 min on a 1-hour cache reply line before, explained after
   1    $4.14   0.5%  effort changed (high -> max)     explained after
   1    $3.47   0.4%  /model re-selected the same model asks first
   2    $0.96   0.1%  model switched                   Claude Code already asks
   3    $1.36   0.2%  compaction                       expected
   2   $12.34   1.4%  no local cause                   explained after
```

Each cause was tested against every request pair, not guessed: 1 of 1 effort changes
and 1 of 1 same-model `/model` commands rewrote the cache; thinking toggles (3 of 56)
and large tool-call batches (0 of 15) did not. The last two misses came 36 seconds and
16 minutes after a warm request with nothing recorded between, so the cache was dropped
on the API side. No local setting prevents that; a smaller context keeps it cheap.

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
npm install --include=dev   # .npmrc omits dev deps so plugin installs download nothing
npm run verify        # typecheck + skill lint + 338 tests
npm run lint:skills   # validate every SKILL.md on its own
npm run coverage      # ~94%
```

CI runs the suite on Ubuntu and Windows across Node 18/20/22, plus an install
smoke test that asserts a pre-existing config survives installation.

## License

MIT — see [LICENSE](LICENSE).
