# Install

```bash
node bin/harness.js install --profile standard
node bin/harness.js doctor
```

Add `--global` to install into `~/.claude` instead of the current project.

## Profiles

Each hook is a node process (~166ms measured), so the profile is a real
overhead choice, not a preference.

| Profile | Hooks | Per-turn cost | Use when |
|---|---|---|---|
| `minimal` | none | zero | You want the skill and CLI tools only |
| `standard` | core, recall | ~1 spawn/turn | Default. Memory works automatically |
| `strict` | core, recall, finalize | ~2 spawns/turn | You want the router to learn from outcomes |

There is deliberately **no PostToolUse hook** in any profile. It would spawn one
process per tool call, and real turns average 12.6 tool calls. The `finalize`
hook reads the transcript at Stop instead, which already holds the same facts.

## Hooks must run under bash

Claude Code runs hook commands through a shell — Git Bash on Windows. The
installer therefore writes a shell-neutral command: `node "<path>" <mode>` with
forward slashes. An earlier `cmd /c` form exited 0 under bash without running
anything, so every hook reported success while doing nothing.

An exit code is not evidence a hook works. Run its exact command through bash
and look for the hook's own output:

```bash
echo '{"context_tokens":400000}' | bash -c 'node "/path/to/learning-hook.cjs" core'
```

Hook settings are read when a session starts, so after installing or fixing
hooks, start a new session before expecting them to fire.

## What install touches

- Copies `skills/token-harness/` into `<claude-dir>/skills/`
- Merges hook entries into `settings.json`, tagged `token-harness`
- Writes `<claude-dir>/harness-state.json` recording exactly what was installed

Existing hooks are never modified. `settings.json` is backed up before every
write. Installing twice is a no-op rather than stacking duplicates.

## Doctor

```bash
node bin/harness.js doctor
```

Checks the state file, the installed skill, the hook script, whether hooks are
actually wired, and the node version. Exits non-zero if anything failed, so it
works in CI.

## Uninstall

```bash
node bin/harness.js uninstall
```

Removes only hooks tagged `token-harness` and deletes the installed skill copy.

**Your memory store and scorecards are never deleted** — they are your data, not
the harness's. Remove `.claude/memory/` by hand if you actually want them gone.

## Never stack install methods

Install one way per project. Layering a manual copy on top of an installed
skill leaves two divergent copies and the older one usually wins.
