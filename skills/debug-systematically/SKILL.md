---
name: debug-systematically
description: Finding the actual cause instead of the plausible one — probing real state, checking derived data, and fixing root causes rather than symptoms. Use when a fix does not work, when behaviour contradicts the code, when a test fails unexpectedly, or when tempted to guess at a cause instead of observing it.
---

# Debug Systematically

## Look at the real bytes before theorising

A hook silently stopped parsing its input. The plausible causes were all wrong.
One probe settled it:

```js
console.log([...raw].slice(0, 8).map(c => c.charCodeAt(0)).join(','));
// 65279,123,34,112,...   <- a UTF-8 BOM
```

`JSON.parse` was throwing on a byte-order mark, and a `catch` was swallowing it
into a fallback. **Two minutes of observation beat twenty of hypothesis.**

When something "looks right" but behaves wrong, suspect what you cannot see:
invisible characters, encoding, escaping, whitespace, line endings.

## A silent catch is where bugs hide

```js
try { return JSON.parse(read(p)); } catch { return {}; }
```

That line destroyed a user's config. The failure had no symptom until much
later, in a different place. Catch blocks that swallow errors convert a loud
failure into a quiet corruption — the worst trade in debugging.

Log it, surface it, or refuse. Never silently substitute a default for an error.

## Check derived state

After redacting secrets from a record's `text`, they were still on disk — the
search index built from the *pre-redaction* text was persisted alongside it.

The obvious field was fixed; the derived copy was not. Ask: what else was
computed from this, cached from this, logged from this, or indexed from this?

## Fix causes, not symptoms

A duplicate-detection check never fired. The symptomatic fix is to add a second
check. The actual cause was that `JSON.stringify` escapes quotes, so a substring
match against a quoted path could never succeed. The real fix was to stop
string-matching serialized data and compare a structural tag instead.

When a fix feels like it is compensating for something, it usually is.

## Suspect your test before your code

Several failures here were wrong expectations, not wrong implementations:

- "delegation loses on a warm cache" — it does not; output price dominates
- "this prompt has a positive signal" — it did not
- "durability should be 7" — the mtime window was inflating it

When a test fails, decide which side is wrong *before* changing either. Never
weaken an assertion to get green.

## Reproduce in isolation

The installer's data-loss bug only appeared in a sandbox with a realistic
pre-existing config. Unit tests all passed. If a bug will not reproduce, the
harness is probably too clean — add the messy real-world condition.

## When the measurement disagrees with the outcome

Establish which one to trust before acting. A score of 0/10 on work that was
clearly done meant the *metric* was broken, not the work. A later score of 1/10
was correct and the earlier 7/10 had been the lie.
