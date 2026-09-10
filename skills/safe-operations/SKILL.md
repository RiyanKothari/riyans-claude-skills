---
name: safe-operations
description: Rules for actions that can destroy work — writing config files, deleting, overwriting, force-pushing, running installers. Use before any operation that modifies files you did not create, before writing to a config another tool owns, before any bulk find-and-replace, and whenever an operation is hard to undo.
---

# Safe Operations

Every rule here comes from something that actually broke.

## The one that matters most

**Never treat "cannot read" as "empty".**

An installer read a `settings.json`, `JSON.parse` threw on a UTF-8 BOM, the
reader returned its `{}` fallback, and the installer wrote that over the file.
The user's model preference and every existing hook were gone.

```js
// Wrong: unreadable and absent collapse into the same answer
function read(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}

// Right: absent is safe to default, unparseable is not
function read(p) {
  if (!fs.existsSync(p)) return { ok: true, value: {} };
  try { return { ok: true, value: JSON.parse(strip(fs.readFileSync(p, 'utf8'))) }; }
  catch (e) { return { ok: false, error: e.message }; }
}
```

If you cannot read it, **refuse and say so**. Do not proceed on a guess.

## Before writing a file you did not create

1. Back it up first. A timestamped copy costs nothing.
2. Merge, never replace. Preserve every key you did not come to change.
3. Verify afterwards that unrelated content survived — assert it, do not assume.

## Destructive commands need a dry run

Deleting, purging and bulk-replacing should print what they *would* do and
require an explicit `--yes` to act. The cost of a confirmation is seconds; the
cost of a wrong `--force` is someone's work.

Before `git checkout` / `reset` / `clean` / `rm -rf` in a repo, run
`git status` and stash anything uncommitted, including untracked files.

## Bulk find-and-replace is dangerous

A repo-wide rename here silently mojibaked every non-ASCII character, which
broke a regex that matched a BOM. The pattern still *looked* right in review.

- Prefer targeted edits over sweeping regex across many files.
- Never round-trip a file through a shell that guesses encodings.
- After any bulk edit, run the tests **and** grep for corruption markers.
- Put non-ASCII in source as escapes (`﻿`), not literal characters, so a
  bad round-trip cannot silently change behaviour.

## Idempotency

Running an installer twice must be a no-op, not a doubling. Detect prior state
**structurally** — a tag or key you own — never by substring-matching a
serialized blob. `JSON.stringify` escapes quotes, so
`json.includes('path" mode')` never matches and every re-run stacks a duplicate.

## Uninstall

Remove only what you recorded installing. Never delete user data — memory
stores, logs, scorecards — even when it lives inside your own directory.

## Actions that need a human first

Publishing a package, pushing, force-pushing, posting to an external service,
deleting a branch, or anything visible to other people. Prepare it fully, then
ask. Approval for one action is not approval for the next.
