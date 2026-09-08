# Adversarial review and fix plan — `@gamaraan/todos-tool`

Date: 2026-09-08. Scope: whole extension (`src/`, `skills/`, config,
packaging, tests) reviewed adversarially; every P1/P2 finding below was
reproduced with inline `bun` checks against the current code. Baseline:
`bun run typecheck` clean, `bun test` 180/180 pass, `bun run verify:package`
clean, pi-lens `0 errors, 0 warnings`.

The tests all pass because the suite never exercises the integration seam
where the actual bug lives: unit tests stub the tracker host one way
(`getPhases: () => tracker.phases`) and the smoke test never checks reminder
behavior after a tool mutation.

---

## P1 — the reported bug: tracker and extension keep two divergent todo snapshots

### Symptom

After finishing a prompt the model receives a completion reminder listing
old (already done) tasks — e.g. scaffold tasks from the start of the
session — and replies "That's a stale reminder … All current todos are
done." Once it starts, it recurs after **every** completed prompt in that
session.

### Root cause

Two copies of the todo state exist:

1. `phases` in `src/index.ts` — the "canonical" copy the `todo` tool's
   `execute` mutates (`index.ts:371` `setPhases(outcome.phases, ctx)`) and
   the HUD/context-formatting reads, and that `/todo` commands commit to.
2. `#phases` in `TodoTracker` (`src/tracker.ts`) — the copy the tracker
   uses for `checkCompletion` (stop-time reminders), `takeMidRunNudge`,
   and the eager-prelude guard.

Writes only flow **tracker → extension** (`tracker.setPhases` calls
`host.setPhases`). Nothing flows extension → tracker. The tracker copy is
only refreshed by `syncFromBranch` at `session_start` / `session_tree` /
`session_compact` (`index.ts:562–573`). So:

- After startup/reload/compact the tracker holds the branch state (e.g.
  scaffold tasks marked `pending`). The agent completes them via the `todo`
  tool — only the index copy moves. At `agent_settled`,
  `checkCompletion` reads its own stale `#phases`, finds "incomplete"
  tasks, and fires a reminder about finished work.
- `before_agent_start` calls `tracker.resetCycle()` on every prompt,
  re-arming the reminder budget while `#phases` stays stale → the reminder
  repeats after every subsequent prompt forever.
- Reverse asymmetry: `todo init` on a fresh session leaves tracker
  `#phases` empty, so `checkCompletion` **never** reminds for genuinely
  incomplete tasks.

### Reproduced (inline `bun`, real extension factory + recorded branch)

- Reminder names a task the tool had already completed. ✔
- Reminder repeats on an unrelated follow-up prompt after the first one. ✔
- Reminder still names the task after `todo rm` cleared the whole list. ✔
- No reminder at all after `todo init` left work genuinely incomplete. ✔

### Fix

Make `src/index.ts`'s `phases` the single source of truth and have the
tracker read through `host.getPhases()` everywhere (`checkCompletion`,
`takeMidRunNudge`, `createEagerTodoPrelude`) instead of its private
`#phases`. Mutations in one place (`setPhases` in `index.ts`) then
simultaneously serve the tool, HUD, `/todo`, and all tracker behaviors;
`syncFromBranch` continues to rehydrate the same single copy at session
events. Remove `#phases`/`setPhases` from the tracker (or reduce it to a
delegating wrapper). Small diff, no API changes.

Regression tests (they exist for none of these seams today):

1. smoke: seed branch with a pending task → `session_start` → execute
   `todo done` → `agent_end`/`agent_settled` → assert no `todo-reminder`
   message sent.
2. smoke: `session_start` with empty branch → `todo init` with two tasks
   → settle with a plain assistant message → assert exactly one
   `todo-reminder` fires.
3. smoke: `/todo done <task>` (command path) → settle → no reminder.
4. `before_agent_start` on a follow-up prompt after a completed reminder
   cycle does not produce a new reminder.

---

## P2 — additional confirmed defects (all reproduced)

| # | Finding | Evidence | Fix |
|---|---------|----------|-----|
| 1 | **Completion reminders fire with the `todo` tool deactivated** (`/tools`-style deactivation or project config disabling while a global reminder budget is armed) — model is told to use a tool it cannot call | `checkCompletion` lacks the `getActiveToolNames().includes("todo")` guard that `takeMidRunNudge` and the eager prelude have (`tracker.ts:246+`); reproduced by disabling the tool then settling with incomplete todos → reminder fires | Add the active-tool guard to `checkCompletion`; test |
| 2 | **Reminders fire after aborted/error runs** — user presses Esc (or the model errors) and the extension immediately re-enters the loop to nag about todos | `agent_settled` handler checks `lastAssistant` only for the awaiting-answer heuristic, never `stopReason` (`index.ts:604-606`); reproduced with `stopReason: "aborted"` and `"error"` → reminder fires | In `checkCompletion`, skip when `lastAssistant.stopReason` is `"aborted"` or `"error"`; test both |
| 3 | **Empty-string task/phase targets silently mean "all"** — `todo done task:""` completes every task; `todo rm task:""` deletes everything | `getTaskTargets` branches on truthiness (`state.ts:338-346`), so `""` falls through to the global-target path; reproduced | Branch on `!== undefined` and reject empty strings via the existing "Missing task content/phase name" errors; also audit `block`/`unblock`. Tests for `task: ""` / `phase: ""` |
| 4 | **Manual paths bypass identity validation** — `/todo append W A` when A exists creates a duplicate; `/todo append W "   "` creates a blank task; markdown import accepts duplicate phase/task names. Duplicates make tasks unaddressable (every targeting op resolves the first match) | `command.ts:384-390` pushes directly; `markdown.ts` parse has no duplicate check while `init`/`append` in `state.ts:379-409` do; reproduced | Share one `validateTodoIdentities(phases)` helper after manual append / markdown parse / editor commit; reject blanks and duplicates (post-normalization). Tests |
| 5 | **Blocker metadata corrupts the Markdown round-trip** — blocker containing `<!-- blocker:` re-parses into corrupted `content`+`blocker`, silently (no parse error) | writer appends raw `<!-- blocker: … -->` (`markdown.ts:49-52`), greedy parse binds the last opening delimiter even inside the blocker itself; reproduced | Encode delimiters in the blocker on write (`<!--`→`%3C!--`, `-->`→`--%3E`, plus `%`→`%25`), decode on read; parser stays compatible with existing exports. Test blockers containing comment markers |
| 6 | **Persisted snapshots with wrongly-typed `blocker` pass validation and crash the renderer** — `{blocker: 123}` restores fine, then `todoRenderResult` throws `text.replace is not a function` on every render; contradicts the documented "corrupt snapshots are skipped, never crash session sync" adaptation | `isTodoPhase` (`state.ts:124-139`) validates `content`/`status` but not optional `blocker`; reproduced | Validate `blocker === undefined \|\| typeof blocker === "string"` in `isTodoPhase`; tests with number/object/array/null blockers |
| 7 | **`/todo` commands can't see an explicitly cleared list** — replay treats a valid empty `user_todo_edit` snapshot as "no snapshot" and falls back to stale in-memory state | `command.ts:212-215` only uses branch state when `fromEntries.length > 0`, while persistence rightly treats `[]` as an authoritative clear; reproduced | Return `TodoPhase[] \| undefined` from `getLatestTodoPhasesFromEntries` (undefined = no snapshot found); adapt the 3 call sites; test |
| 8 | **`/todo edit` can overwrite concurrent progress** — snapshot taken when the editor opens is committed wholesale when it exits; any `todo`/command mutation meanwhile is lost | `command.ts:513-541` commits without comparing current state to the prefill snapshot; reproduced with a deferred editor + intervening `todo append` | Compare current vs prefill snapshot at commit; on divergence warn ("todos changed while editing; reopening") and re-open with fresh state instead of overwriting. Deferred-editor regression test |
| 9 | **`/todo export` silently overwrites existing files and follows symlinks** | `command.ts:305` unconditional `fs.writeFile` under a user-chosen path; default `TODO.md` may hold unrelated content | Refuse symlink targets (`lstat`), and if the file exists require explicit confirmation (TUI prompt) or fail with "exists — pass an explicit path" outside TUI. Tests |
| 10 | **Invalid env/flag overrides silently disable or silently enable** — `PI_TODO_REMINDERS_MAX=" "` → `Number("")` → `0` disables reminders with no warning; `PI_TODO_ENABLED=of` (typo) ignored → defaults to enabled | `config.ts` `parseRemindersMaxOverride` accepts whitespace; `parseBooleanOverride`/`parseEagerOverride` return `undefined` with no warn hook unlike JSON parsing; reproduced | Trim-empty → undefined; warn through the existing `warn` callback on unrecognized override values. Tests |
| 11 | **Superseded tracker messages persist in LLM context forever** — every completion reminder / mid-run nudge is appended as a `custom_message` with `details` pointing at a moment-in-time todo list; after resume or rewind the old `<system-reminder>` text ("You stopped with N incomplete…") still sits in context and invites exactly the "stale reminder" self-talk the model shows | `sendReminder` (`index.ts:318-325`) uses `pi.sendMessage(…, {triggerTurn: true})`; pi persists custom messages to the session branch | Add a `context` handler that strips prior `todo-reminder` / `mid-run-todo-nudge` messages except the newest pending one before each LLM call (non-destructive; session file retains history). Test a resume: old reminder pruned from outgoing context |

---

## P3 — improvements and inconsistencies

1. **Renderer phase numbering diverges from the HUD.** `todoRenderResult`
   drops empty phases then re-numbers (`render.ts:342+`), so phase "Work"
   shows as `I.` in tool output but `II.` in the HUD (which preserves
   original indices — asserted in the smoke test). Keep the original
   index when filtering empty phases so both surfaces agree.
2. **`before_agent_start` fires for context-nudge turns on 0.84.x**, so a
   preloaded mid-run nudge arrives with `event.prompt === undefined` and
   `createEagerTodoPrelude` treats it as a prompt-less turn. Harmless
   today (guarded by `#phases.length > 0`), but add a comment + test
   pinning the intended "first real user turn only" behavior.
3. **Awaiting-user heuristic** misses Markdown-decorated trailing lines:
   `**Should I continue?**` and `Which approach should I take?\n\nThanks.`
   both return false (reproduced). Strip `**`/`_`/`` ` `` decoration from
   the last line before the question/response-cue regexes.
4. **"Out-of-order completion" doc wording** — the tool description says
   "earliest still-open task auto-promotes"; actually an existing
   `in_progress` b is preserved over an earlier pending a (reproduced).
   Wording is fine once you know, but reorder the sentence so the pointer
   rule reads as "earliest open task *unless* a task is already in
   progress".
5. **OMP parity note** — findings P2-3, P2-4 (tool-side duplicate
   handling is fine in `state.ts`, but the same empty-target and
   blocker-escaping bugs) very likely exist in OMP's `tools/todo.ts`.
   After fixing here, port the fixes upstream (per AGENTS.md "keep the
   port faithful").

---

## Things explicitly reviewed and OK

- Batch atomicity / error-through-throw contract (`execute.ts`) — solid.
- Persistence replay safety for `phases` arrays, corrupt-snapshot
  skipping, empty-array-as-clear semantics (`persistence.ts`) — matches
  the documented hardening vs OMP.
- `saveTodoConfig` temp-then-rename + symlink refusal — good.
- External editor temp file: `mkdtemp` 0700 + 0600 — good (documented
  adaptation).
- `supportsTodoTerminalNotifications` terminal allowlist, EventBus
  try/catch isolation, notify gating on `ctx.mode === "tui"` — good.
- `normalizeSingleLine` at init/append and blocker `reason` collapsing —
  the architecturally correct choke point.
- Mid-run nudge budget/reset semantics — faithful to OMP.
- `resolveTodoParams`/`inferTodoOp` leniency — covered by tests, sane.
- HUD scroll logic + frozen `WIDGET_MAX_LINES` — documented mirror of a
  private pi constant; acceptable, flagged in code comment.
- `prepareArguments` op-inference — matches OMP's lenient validation.
- Package manifest (files list, peer deps optional meta, provenance) —
  `verify:package` clean.

## What was not covered

- Live TUI behavior (widget clipping, OSC 52, editor dialogs) — needs the
  pre-release manual smoke checklist from AGENTS.md; P1 regression (1)
  should be run there too once fixed.
- OMP-side behavioral drift outside the files listed in AGENTS.md (the
  port mapping) — reviewed only `todo-tracker.ts`, `todo.ts` portions.

---

## Suggested implementation order

1. **P1 + P2-1/2/3/11** (reminder correctness: single source of truth,
   active-tool guard, stopReason guard, empty-target guard, context
   pruning) — this is the user-visible bug family. Add the four P1
   regression tests; `bun run typecheck && bun test` must pass.
2. **P2-4/5/6/7** (data integrity: identity validation, blocker escaping,
   persisted-field validation, empty-snapshot semantics).
3. **P2-8/9/10** (UX/data safety: editor conflict, export hardening,
   override warnings).
4. **P3** polish, then upstream the applicable fixes to OMP.
5. Manual smoke pass against a real pi session before tagging the next
   release.
