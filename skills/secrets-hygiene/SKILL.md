---
name: secrets-hygiene
description: Keeping credentials out of files, stores and repositories — redacting at write time, scanning before committing, and handling a leak that already happened. Use before committing or publishing anything, before storing prompt or conversation text, when initialising a repo, and whenever a tool persists user input to disk.
---

# Secrets Hygiene

## Redact at write time, not before commit

Anything built from prompts or conversation text will eventually contain a live
credential, because people paste keys into chat. Scrubbing at commit time is too
late — by then it has been synced, backed up or shared.

A memory store here was seeded from real transcripts and picked up seven records
containing Razorpay keys, an Anthropic key, a Gemini key, Meta tokens and a
Postgres URL. The fix was redaction inside `add()`, so a secret never reaches
disk at all.

```js
const SECRET_PATTERNS = [
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\brzp_(?:test|live)_[A-Za-z0-9]{10,}/g,
  /\bAIza[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bEAA[A-Za-z0-9_-]{20,}/g,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s:@]+:[^\s@]+@\S+/gi,
  /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*["']?[A-Za-z0-9_\-./+]{12,}["']?/gi,
  /\bBearer\s+[A-Za-z0-9._-]{20,}/g,
];
```

Redact rather than reject — the record keeps its value, the secret does not
survive.

**Get the character classes right.** The first version used `[A-Za-z0-9]` and
missed every Meta token, because those contain `_` and `-`. A pattern that
half-matches gives false confidence.

## Derived data leaks too

After redacting the `text` field, secrets were still on disk — in `_terms`, a
tokenized search index built from the text *before* redaction and then
serialized alongside it.

**Any cache, index, embedding or log derived from sensitive input inherits the
sensitivity.** The fix was to stop persisting derived state at all: it is
rebuildable, it bloated the file, and it leaked. The store shrank 54KB to 35KB
as a side effect.

## Before a repo goes public

1. `git init` in the project, not a parent. Check `git rev-parse --show-toplevel`
   — a project inside a home-directory repo will publish far more than intended.
2. Grep the staged set for credential shapes before the first commit.
3. Gitignore user data by default: memory stores, logs, local settings, `*.bak`.
4. Check what is actually staged. 329 files here turned out to include 246 files
   of another tool's generated content.

## If a secret was already committed

Deleting the file is not enough — git history keeps it. Assume it is
compromised:

1. **Rotate the key first.** Cleaning history without rotating protects nothing.
2. Then purge with `git filter-repo` or BFG, and force-push with the team warned.
3. If it ever reached a public remote, treat it as fully public regardless of
   how briefly it was up.

## Never put secrets in these

URLs and query strings, log lines, error messages, commit messages, or anything
sent to a third-party service — including diagram renderers and pastebins.
