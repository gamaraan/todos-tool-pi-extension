---
name: todo-discipline
description: >
  Mandatory execution discipline for the phased `todo` tool. Use whenever a
  request decomposes into 3+ distinct steps, arrives as a plan/checklist, or
  enumerates N items/bugs/tasks: create the phased todo list with a single
  `init` BEFORE working, then keep it live — mark each individual task done
  the moment that task finishes. Never batch todo updates at the end of a
  phase, turn, or session. Applies to every session and every model.
---

# Todo Discipline

This skill governs how the `todo` tool is used for the entire session. It has
two hard rules: **plan before working**, and **mark progress the moment it
happens**.

## Rule 1 — Initialize the phased list BEFORE working

When a request decomposes into 3+ distinct steps, or the user provides a plan
(markdown headings + checklists, numbered/bulleted steps) or enumerates N
items/bugs/tasks:

1. Call `todo init` first, in the same turn, before any read/edit/bash work on
   the request itself.
2. Organize the work into phases (short noun phrases, no `1.`/`Phase 1:`
   prefixes) covering the whole request — investigation through verification —
   not just the next immediate step.
3. Every item is its own task (5–10 words, verbatim user wording where
   concise). NEVER summarize, merge, sample "the important ones", or drop
   items from the list.
4. Batch the `init` call with your first real tool call (a read, a grep); a
   solo todo call wastes a round trip.

A plan you can see but do not track is a plan you will partially execute.

## Rule 2 — Mark each task done the moment it finishes

- `start` a task when you begin it; `done` it immediately after its outcome is
  verified — batched with the NEXT real action, never deferred.
- NEVER accumulate finished-but-unmarked tasks to close out later. Marking ten
  tasks done retroactively at the end of a phase or session violates this
  rule. If you notice unmarked finished work at any point, stop and mark it
  done NOW before continuing new work.
- Complete phases in order. A task is only `done` when its observable outcome
  exists and was confirmed (change applied + check ran, question answered with
  evidence, fix reproduced-then-fixed). Otherwise `block` it with a reason.
- Keep introduced `task`/`phase` strings stable; never rename tasks to dodge
  history. Lost exact text: `todo view` echoes the list — never guess from
  memory.
- New instructions arrive mid-task → capture them (`append`) before doing work
  under them. User cancels a task → `drop` it; never leave it hanging.

## Anti-patterns

| Anti-pattern | Correct behavior |
| --- | --- |
| Executing steps without an `init` first | `todo init` covering the whole request, then work |
| Finishing task after task, marking nothing | `done` each task immediately after verifying it |
| One bulk `done` call closing several tasks at end of phase/session | Each task marked done as its own step completes |
| Claiming completion without running the check | Run the check; only then `done` |
| Summarizing a task list into "the important ones" | Enumerate all tasks verbatim |
