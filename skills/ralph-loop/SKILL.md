---
name: ralph-loop
description: Run a bounded self-correcting loop that re-feeds the same prompt every time Claude stops, until a completion promise is genuinely true or an iteration cap is reached. Use when a task has a machine-checkable finish line such as a passing test suite or a clean linter, and iterating unattended beats steering each step by hand.
---

# Ralph Loop

The Ralph technique (Geoffrey Huntley) is a loop around one prompt. You work, try to
stop, and get the same prompt back. Your earlier work is still there in the files
and git history, so each pass picks up where the last one left off.

This is an independent Node implementation. It needs no `jq` or `perl`, so it runs
under Git Bash on Windows, and it requires the standard or strict profile, which
wires its Stop hook.

## Start

When invoked as `/ralph-loop <task>`, start the loop with the task and continue
working on it in the same turn:

```bash
rcskills loop start 'Make npm test pass with no skipped tests' --completion-promise 'ALL TESTS PASS' --max-iterations 15
```

- `--max-iterations` defaults to 10 and is capped at 100. There is no unlimited mode.
- `--completion-promise` is the exact phrase that ends the loop. Without one, the loop
  runs to the cap.
- Use single quotes, so the shell leaves `$` and backticks in the prompt alone.

Check it with `rcskills loop status` and stop it with `rcskills loop cancel`.

## The promise rule

End the loop only by writing `<promise>PHRASE</promise>` in your own reply, and only
when that statement is completely true and verified by output you actually saw. Do
not write the tag to explain, plan or quote it — a written tag counts. If you are
stuck, say so plainly and let the cap end the loop; a false promise is a lie told to
escape, and it ships broken work as finished.

## Write prompts that can finish

A loop is only as good as its finish line.

- Name a check a command can prove: tests pass, `tsc` is clean, the linter reports 0.
- Break large goals into phases the prompt lists in order.
- Say what to do when blocked: record what was tried and what is in the way.

Good fits: getting a suite green, clearing lint or type errors, working through a
mechanical migration. Bad fits: design decisions, anything needing human judgment,
production incidents, tasks with no objective check.

## Cost

Every iteration re-reads the whole context, so a loop multiplies whatever the session
already costs. Keep caps small, prefer a fresh session for a long loop, and expect the
`[context]` compaction prompt to appear sooner than usual.

## Guarantees

- Only the session that started a loop is ever blocked by it.
- State lives in `~/.claude/token-harness/loops/`, never in the project.
- Unreadable state ends the loop rather than trapping the session.
