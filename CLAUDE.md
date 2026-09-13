# Ruflo — Claude Code Configuration

## Rules

- Do what has been asked; nothing more, nothing less
- NEVER create files unless absolutely necessary — prefer editing existing files
- NEVER create documentation files unless explicitly requested
- NEVER save working files or tests to root — use `/src`, `/tests`, `/docs`, `/config`, `/scripts`
- ALWAYS read a file before editing it
- NEVER commit secrets, credentials, or .env files
- NEVER add a `Co-Authored-By` trailer to user commits unless this project's `.claude/settings.json` has `attribution.commit` set (#2078). The Claude Code Bash tool may suggest one in its default commit-message template — ignore it. `Co-Authored-By` is semantic authorship attribution under git/GitHub convention; the tool is the facilitator, not a co-author.
- Keep files under 500 lines
- Validate input at system boundaries

## Self-scorecard (run after every task, without being asked)

```bash
npm run scorecard -- score --title "what I did" --scopeFit 8 --scopeFit-why "reason"
npm run scorecard -- trend
```

Seven parameters weighted to 100. Four — correctness, verification, durability,
efficiency — are **evidence-gated** and cap at 5/10 without real measurement, no
matter what I claim. Durability reads the transcript, so shipping code without
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

The cheapest token is the one never generated; this compounds with model-tier
routing below, which only makes the remaining work cheaper.

## Model-Tier Routing (token cost control)

Pick the cheapest model that can do the task correctly. Check any prompt with
`npm run route -- "<prompt>"`.

| Tier | Signals | Model | Action |
|---|---|---|---|
| trivial | typo, rename, format, version bump | haiku | Delegate: Agent tool with `model: "haiku"` |
| simple | one mechanical edit, add a field | haiku | Delegate: Agent tool with `model: "haiku"` |
| moderate | ordinary bounded feature work | sonnet | Handle inline |
| complex | architecture, refactor, debugging, tradeoffs | opus | Handle inline |

- Delegate trivial/simple work to a `haiku` subagent — roughly 77–89% cheaper per call than opus, depending on how much context is cached.
- Never downgrade an ambiguous task; the router escalates a tier on low confidence, so should you.
- Reasoning prompts (why / how should / tradeoff) never route to haiku.
- If the session model outclasses the work for a whole stretch of tasks, tell the user to switch with `/model`.
- Delegation only pays when the subtask is self-contained. If explaining the context costs
  more than the work, do it inline.

Verify with `npm test` before claiming any of this works.

## Memory (fixed core + bounded recall)

Two tiers, both capped so neither can bloat context.

**Fixed core** — injected into *every* session at SessionStart, unconditionally,
capped at 400 tokens. It carries standing policy across model swaps and context
resets, so a fresh session is never blank.

- Pinned records are always core (`npm run mem -- add "..." --pin`).
- A record retrieved 5+ times that reaches full strength graduates into core on
  its own evidence. The core curates itself; do not hand-pin what usage proves.

**Per-prompt recall** — BM25-ranked, capped at 350 tokens, silent when nothing
scores. Do not dump memory into context. Query it, and let it return only what fits.

```bash
npm run mem -- recall "<what you need to know>" --budget 400
npm run mem -- add "<durable fact worth keeping>" [--pin]
```

- Recall is BM25-ranked and capped by a token budget, so it can never bloat the
  prompt no matter how large the store grows.
- Memories decay on an exponential half-life and strengthen each time they are
  retrieved. Unused ones prune themselves; `--pin` exempts a fact from decay.
- Pin only standing policy. Let everything else earn its place through use.

Recall before starting non-trivial work; add a fact when a session produces
durable knowledge that the code itself does not already state.

## Ruflo Capability Brain & Implementation Loop

Ruflo is the coordination ledger and policy decision point. Claude Code is the
executor: after a Ruflo coordination call, continue implementing the task.

When it is registered, call
`guidance_brain({ mode: "recommend", task: "..." })` before complex Ruflo
work. Use its live registry instead of guessing tool names. Treat
`registered`, `configured`, `reachable`, `healthy`, and `authorized`
as separate facts. If the brain is unavailable, continue with the compatible
`guidance_recommend` tool, CLI discovery, and repository instructions.

Follow the returned loop:

1. Recall memory and ADR constraints.
2. Inspect source, runtime, dependencies, policy, and health.
3. Route to the smallest capable topology, agents, skills, and tools.
4. Plan acceptance criteria, safety envelope, ownership, and validation.
5. Execute in isolated scopes; the coding agent performs the work.
6. Test focused, regression, and failure paths.
7. Validate types, security, policy, compatibility, and artifacts.
8. Benchmark a source-bound candidate against a source-bound baseline.
9. Optimize measured bottlenecks without weakening safety.
10. Bind claims and evidence to exact source/build receipts.
11. Reconcile concurrent handoffs and disclose limitations.
12. Publish only through a separately authorized release gate.

### Concurrency and authority

- Never allow two writers in one worktree; give each writing agent an isolated
  worktree and explicit file ownership.
- Read-only research may run concurrently and report findings to the owner.
- Only the integration owner edits shared manifests and lockfiles or reconciles
  overlapping changes.
- A child may drop capabilities but cannot add tools, network, secrets, spend,
  concurrency, namespaces, or delegation depth.
- A lease or claim coordinates ownership; it does not authorize a side effect.
- Darwin, Flywheel, MetaHarness, memory, and neural systems may propose or
  evaluate candidates but cannot self-promote or expand their SafetyEnvelope.
- Bind tests, benchmarks, policy decisions, and release evidence to an exact
  commit or immutable dirty-worktree snapshot.

## Agent Comms (SendMessage-First Coordination)

Named agents coordinate via `SendMessage`, not polling or shared state.

```
Lead (you) ←→ architect ←→ developer ←→ tester ←→ reviewer
              (named agents message each other directly)
```

### Spawning a Coordinated Team

```javascript
// ALL agents in ONE message, each knows WHO to message next
Agent({ prompt: "Research the codebase. SendMessage findings to 'architect'.",
  subagent_type: "researcher", name: "researcher", run_in_background: true })
Agent({ prompt: "Wait for 'researcher'. Design solution. SendMessage to 'coder'.",
  subagent_type: "system-architect", name: "architect", run_in_background: true })
Agent({ prompt: "Wait for 'architect'. Implement it. SendMessage to 'tester'.",
  subagent_type: "coder", name: "coder", run_in_background: true })
Agent({ prompt: "Wait for 'coder'. Write tests. SendMessage results to 'reviewer'.",
  subagent_type: "tester", name: "tester", run_in_background: true })
Agent({ prompt: "Wait for 'tester'. Review code quality and security.",
  subagent_type: "reviewer", name: "reviewer", run_in_background: true })

// Kick off the pipeline
SendMessage({ to: "researcher", summary: "Start", message: "[task context]" })
```

### Patterns

| Pattern | Flow | Use When |
|---------|------|----------|
| **Pipeline** | A → B → C → D | Sequential dependencies (feature dev) |
| **Fan-out** | Lead → A, B, C → Lead | Independent parallel work (research) |
| **Supervisor** | Lead ↔ workers | Ongoing coordination (complex refactor) |

### Rules

- ALWAYS name agents — `name: "role"` makes them addressable
- ALWAYS include comms instructions in prompts — who to message, what to send
- Spawn ALL agents in ONE message with `run_in_background: true`
- After spawning, continue independent local work; wait only when a dependency
  genuinely blocks progress
- Do not poll repeatedly — agents message back or complete automatically
- Give every writing agent an isolated worktree and a non-overlapping file scope

## Swarm & Routing

### Config
- **Topology**: hierarchical-mesh (anti-drift)
- **Max Agents**: 15
- **Memory**: hybrid
- **HNSW**: Enabled
- **Neural**: Enabled

```bash
npx @claude-flow/cli@latest swarm init --topology hierarchical --max-agents 8 --strategy specialized
```

### Agent Routing

| Task | Agents | Topology |
|------|--------|----------|
| Bug Fix | researcher, coder, tester | hierarchical |
| Feature | architect, coder, tester, reviewer | hierarchical |
| Refactor | architect, coder, reviewer | hierarchical |
| Performance | perf-engineer, coder | hierarchical |
| Security | security-architect, auditor | hierarchical |

### When to Swarm
- **YES**: 3+ files, new features, cross-module refactoring, API changes, security, performance
- **NO**: single file edits, 1-2 line fixes, docs updates, config changes, questions

### 3-Tier Model Routing

| Tier | Handler | Use Cases |
|------|---------|-----------|
| 1 | Agent Booster (WASM) | Simple transforms — skip LLM, use Edit directly |
| 2 | Haiku | Simple tasks, low complexity |
| 3 | Sonnet/Opus | Architecture, security, complex reasoning |

## Memory & Learning

### Before Any Task
```bash
npx @claude-flow/cli@latest memory search --query "[task keywords]" --namespace patterns
npx @claude-flow/cli@latest hooks route --task "[task description]"
```

### After Success
```bash
npx @claude-flow/cli@latest memory store --namespace patterns --key "[name]" --value "[what worked]"
npx @claude-flow/cli@latest hooks post-task --task-id "[id]" --success true --store-results true
```

### MCP Tools (use `ToolSearch("keyword")` to discover)

| Category | Key Tools |
|----------|-----------|
| **Memory** | `memory_store`, `memory_search`, `memory_search_unified` |
| **Bridge** | `memory_import_claude`, `memory_bridge_status` |
| **Swarm** | `swarm_init`, `swarm_status`, `swarm_health` |
| **Agents** | `agent_spawn`, `agent_list`, `agent_status` |
| **Hooks** | `hooks_route`, `hooks_post-task`, `hooks_worker-dispatch` |
| **Security** | `aidefence_scan`, `aidefence_is_safe`, `aidefence_has_pii` |
| **Hive-Mind** | `hive-mind_init`, `hive-mind_consensus`, `hive-mind_spawn` |

### Background Workers

| Worker | When |
|--------|------|
| `audit` | After security changes |
| `optimize` | After performance work |
| `testgaps` | After adding features |
| `map` | Every 5+ file changes |
| `document` | After API changes |

```bash
npx @claude-flow/cli@latest hooks worker dispatch --trigger audit
```

## Agents

**Core**: `coder`, `reviewer`, `tester`, `planner`, `researcher`
**Architecture**: `system-architect`, `backend-dev`, `mobile-dev`
**Security**: `security-architect`, `security-auditor`
**Performance**: `performance-engineer`, `perf-analyzer`
**Coordination**: `hierarchical-coordinator`, `mesh-coordinator`, `adaptive-coordinator`
**GitHub**: `pr-manager`, `code-review-swarm`, `issue-tracker`, `release-manager`

Any string works as a custom agent type.

## Build & Test

- ALWAYS run tests after code changes
- ALWAYS verify build succeeds before committing

```bash
npm run build && npm test
```

## Ruflo CLI

`npx ruflo <command> --help` — 26 commands. Run `ruflo doctor --fix` if the MCP
server misbehaves. The background `daemon` is optional and spawns headless
`claude` sessions on an interval, so it burns tokens continuously; leave it off
unless you want those sweeps.

**Agent tool** executes (files, code, git). **MCP tools** coordinate (swarm,
memory, hooks).
