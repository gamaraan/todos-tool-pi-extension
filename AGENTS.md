# AGENTS.md — todos-tool development guide

Guidance for any future development in this repository. Read this before
touching the code.

## What this project is

`@gamaraan/todos-tool` — a pi coding-agent **extension package** that ports the
Oh My Pi (OMP) todo tool, todo tracker, and `/todo` command to pi.

- **The port source is OMP**: `oh-my-pi/packages/coding-agent/src/tools/todo.ts`,
  `session/todo-tracker.ts`, `modes/controllers/todo-command-controller.ts`,
  plus `prompts/tools/todo.md`, `prompts/system/eager-todo.md`,
  `prompts/system/mid-run-todo-nudge.md`. The file-by-file source mapping
  (with OMP line ranges) is the Layout table below; deliberate behavior
  differences are listed in the README's "Differences from OMP" table.
- **Hard constraint: this is an extension, not a core change.** Do NOT modify
  any file under `pi-mono/packages/*/src/` to make the extension work. If a
  pi API is missing, approximate with what the extension API offers (e.g.
  the eager prelude injects a MUST-call reminder because extensions cannot
  force a `tool_choice`) and document the difference.

## Layout

| Path | Content | Ported from |
| --- | --- | --- |
| `src/index.ts` | Extension entry: tool registration, `/todo` command, event wiring, HUD widget | wiring glue (omp interactive-mode) |
| `src/types.ts` | Todo types + TypeBox `todoSchema` | `tools/todo.ts:21-92` (omptype → typebox) |
| `src/state.ts` | Pure state ops (applyEntry, init/append/remove, transitions, normalization, op inference, collapsed viewport) | `tools/todo.ts:95-616` |
| `src/execute.ts` | `executeTodoOp` — the tool's execute semantics as a pure function (batch atomicity, throw-on-error contract) | `tools/todo.ts:857-896` |
| `src/markdown.ts` | `phasesToMarkdown`/`markdownToPhases`/`resolveTodoMarkdownPath` | `tools/todo.ts:618-715` + path-utils subset |
| `src/persistence.ts` | `getLatestTodoPhasesFromEntries`, `USER_TODO_EDIT_CUSTOM_TYPE` | `tools/todo.ts:175-198` |
| `src/format.ts` | `formatSummary` (the text the model sees) | `tools/todo.ts:789-933` |
| `src/render.ts` | `todoRenderCall`/`todoRenderResult` (pi-tui `Text` components), sanitization, roman numerals, strike helpers | `tools/todo.ts:899-1270` (adapted: no spinner frame, no framed blocks) |
| `src/tracker.ts` | `TodoTracker`: eager prelude, mid-run nudges, completion reminders, awaiting-user heuristic | `session/todo-tracker.ts` |
| `src/command.ts` | `/todo` controller + `$EDITOR` fallback | `todo-command-controller.ts` |
| `src/config.ts` | `todo.json` loading (global + trusted project) | settings-schema.ts subset, next-prompt config pattern |
| `src/prompts.ts` | Tool description + eager/nudge templates (flattened from Handlebars) | `prompts/*.md` |
| `test/` | Unit tests; **port from** `oh-my-pi/packages/coding-agent/test/tools/todo.test.ts` and `test/modes/controllers/todo-command-controller.test.ts` | |

## Conventions

- **Keep the port faithful.** When behavior differs from OMP, it must be a
  deliberate, documented adaptation (see the README's "Differences from OMP"
  table). When in doubt, match OMP.
- **Prompt text lives in `src/prompts.ts`** as template functions. If OMP's
  prompt `.md` files change, port the changes here (flattened, no
  Handlebars).
- **Errors are thrown.** pi's `ToolDefinition.execute` has no `isError`
  result field — throwing is the error signal. `executeTodoOp` returns
  `failed` and `index.ts` throws `outcome.summary`.
- **Persistence = branch replay.** Tool results carry `details.phases`;
  manual edits write `user_todo_edit` custom entries. Never add a sidecar
  file for todo state.
- **Tool result contract**: every successful `todo` result carries
  `details: { op, phases, storage, completedTasks? }` — `details.phases` is
  the durable record the branch replay reads, so keep this shape stable.
- **Config via `todo.json`** (agent dir + `<cwd>/.pi/`), not pi settings.
  Keep `enabled: false` as a global floor (fail closed).
- **No inline imports, no `any`.** Follow the project's TypeScript strictness
  (`noUncheckedIndexedAccess` — guard array access with `?? ""` / `!` where
  the code guarantees presence).
- **No `bun-test-shim.d.ts`** — the shim's narrowed `expect` type breaks
  `toThrow()`; `@types/bun` provides proper `bun:test` types. Don't re-add it.
- **Keep `todo` tool registration `executionMode: "sequential"`** (omp's
  `concurrency = "exclusive"`).
- **Testing conventions**: pure logic is tested directly (state/markdown/
  persistence/format/render/tracker/command/config); `test/smoke.test.ts`
  runs the real extension factory against a recording `ExtensionAPI` stub and
  dispatches real handlers (session sync, eager prelude, steer nudges).
  Renderer tests use `makeTestTheme()` (the `theme` singleton is not exported
  from the pi package index).
- **Verification**: `bun run typecheck` and `bun test` must pass; the
  extension must load through the real pi binary (sandboxed
  `PI_CODING_AGENT_DIR` + `settings.json` `extensions` entry) without
  "Failed to load extension" diagnostics. New behaviors need regression
  tests, ported from OMP's suite where one exists.
- **CI**: `.github/workflows/test.yml` runs typecheck + tests + package
  verification on every PR push to main; `.github/workflows/publish.yml`
  re-verifies and publishes to npm (with provenance) on `v*` tags.
- **Pre-release manual smoke checklist** — terminal rendering and live
  interaction can't be unit-tested; before each release run these in a real
  pi session with a working model (against the installed package) and
  record results:

  1. **Tool flow** — "plan X in 3 phases" renders roman-numeral phase
     headers, checkboxes, and progress (`1/3`); completing a task strikes
     it through and the next pending task auto-promotes; the collapsed
     viewport expands with `ctrl+e`.
  2. **Persistence** — todos survive `/new`/restart; after a rewind
     (`/tree`) the state matches that point in history.
  3. **HUD** — `N/M done` widget updates after every `todo` result and
     `/todo` command; disappears after `/todo rm (all)`; absent in
     `--mode json` / `-p` runs.
  4. **`/todo`** — append auto-creates a missing phase; start/done fuzzy
     match; `edit` acknowledges manual changes on the next agent turn;
     export → rm → import round-trips; `copy` pastes via OSC 52; after
     `rm (all)` the agent does NOT recreate the list on its own.
  5. **Eager prelude** — `"preferred"` opens multi-step sessions with a
     phased `todo init`; `"always"` does so on the first turn of a NEW
     session only (question prompts don't trigger it); resuming never
     injects it.
  6. **Mid-run nudge** — 12+ mutating tool results with incomplete todos
     eventually produce a `todo done` call (≤2 per cycle).
  7. **Completion reminder** — stopping with incomplete todos fires a
     reminder turn; not when ending with a question or all complete;
     suppressed by `"reminders": false` / `"remindersMax": 0`.
  8. **Disabled** — `"enabled": false` removes the tool and all tracker
     behaviors; `/todo` still works for manual lists.

## Guardrails inherited from the user's global rules

- **No installs without approval.** `bun install` / new dependencies require
  presenting the exact plan and waiting for explicit approval. Dev
  dependencies are pinned to the published pi packages (`0.84.1`), mirroring
  `next-prompt-extension`.
- **Never push to main; always work on a feature branch + PR.** Follow the
  git workflow (branch → PR → user merges → cleanup). CI
  (`.github/workflows/test.yml`) runs the full gate on every PR push to
  main — don't merge before it passes.
- **Never wipe existing content.** Read before edit; use targeted edits.
- **License**: MIT, and the LICENSE must retain the OMP (© Can Bölük) and pi
  (© Mario Zechner) copyright notices — this is a port of their code.

## Scope boundaries

- **Subagents / task machinery**: deliberately out of scope. The tracker's
  subagent-touching hooks (`createEagerTaskPrelude`,
  `#reconcileTodosWithSubagents`, `setActiveTodoDescriptionsProvider`,
  `todoMatchesAnyDescription` matcher wiring) are omitted — re-add them only
  when pi grows in-process subagents, un-guarding the existing seams.
  Their self-disable guards: `createEagerTaskPrelude` returns undefined
  unless `task.eager === "always"` AND `"task"` is in the active tools;
  `#reconcileTodosWithSubagents` only runs in the main session and matches
  finished-subagent descriptions (a no-op without subagents).
- **Plan mode**: pi's plan-mode is an example extension, not core; the
  tracker stubs `planModeEnabled() → false`. Don't add plan-mode coupling
  without revisiting this decision.
- **OMP support**: intentionally not supported (OMP ships its own native
  `todo` tool — duplicate tool name). Do not add `@oh-my-pi/*` dev
  dependencies or an `tsconfig.omp.json`.
