# Port plan: todo tool + tracker → pi

Target: `pi-mono` (pi working tree). Follows the four outlined steps; everything below maps omp source to pi destinations with contracts and verification.

Scope: **todos only**. No subagent/task machinery. Omitted on purpose: `createEagerTaskPrelude`, `#reconcileTodosWithSubagents`, `setActiveTodoDescriptionsProvider`, hub/registry — all self-disable or are guarded no-ops without subagents (see RESEARCH.md §2.3).

## Phase 0 — Decisions

1. **Placement: core-integrated** (not an example extension). Rationale: the eager prelude needs pre-prompt message + forced `tool_choice` injection, which pi's extension API cannot do (extensions get `session_start`/`agent_end`/`message_end` events and `ctx.sendMessage` steering, but no pre-prompt injection hook). omp did exactly this — `TodoTracker` lives in `AgentSession` (`session/todo-tracker.ts`, wired at `session/agent-session.ts:1000`).
2. **New module**: `pi-mono/packages/coding-agent/src/core/todos/` — one directory, one concern. The tool goes through pi's `ToolDefinition` contract (`core/extensions/types.ts:449`) like every other custom tool, so it works in TUI, RPC, JSON, and print modes without special-casing.
3. **Schema: typebox** (`Type.Object`/`StringEnum`, as used by `core/tools/*.ts`). No omptype dependency.
4. **Baseline**: pi `createAgentSession` → `AgentSession` (core/sdk.ts:169, core/agent-session.ts) is the integration surface. The harness (lanes) is out of scope — unimplemented (`HarnessNotImplemented`, RESEARCH.md §3.1).

## Phase 1 — Tool core (pure logic, no session)

Files under `src/core/todos/`:

| File | Content | Ported from |
|---|---|---|
| `types.ts` | `TodoStatus`, `TodoOperation`, `TodoItem` (`content/status/blocker?`), `TodoPhase` (`name/tasks`), `TodoToolDetails` (`op/phases/storage/completedTasks?`), `TodoCompletionTransition`; typebox `todoSchema` + `TodoOp` enum | `tools/todo.ts:21-92` |
| `state.ts` | Pure ops: `applyEntry`, `initPhases`, `appendItems`, `removeTasks`, `getCompletionTransitions`, `normalizeInProgressTask`, `nextActionableTask`, `inferTodoOp`, `resolveTodoParams`, `applyParams`, `applyOpsToPhases`, `isTodoPhase`, `isClosedTodo` | `tools/todo.ts:95-616` |
| `markdown.ts` | `phasesToMarkdown`, `markdownToPhases`, `resolveTodoMarkdownPath`, `STATUS_TO_MARKER`/`MARKER_TO_STATUS` | `tools/todo.ts:618-715` |
| `persistence.ts` | `getLatestTodoPhasesFromEntries`, `USER_TODO_EDIT_CUSTOM_TYPE` | `tools/todo.ts:175-198` |
| `format.ts` | `formatSummary` (text result for the model), phase display (`phaseRomanNumeral`, `formatPhaseDisplayName`) | `tools/todo.ts:789, 933-984` |
| `render.ts` | `todoToolRenderer` → pi `renderCall`/`renderResult` returning pi-tui `Component`s; strikethrough reveal; collapsed viewport (`selectCollapsedTodos`) | `tools/todo.ts:899-1270` |
| `tool.ts` | `TodoTool` as pi `ToolDefinition` (or `AgentTool`): `name: "todo"`, `label: "Todo"`, typebox schema, `prepareArguments` for op inference (replaces omp's `lenientArgValidation`), `executionMode: "sequential"` (omp `concurrency = "exclusive"`), `execute` implementing op semantics | `tools/todo.ts:795-897` |
| `prompt.ts` | Description rendered from a `.md` template (pi convention: `promptSnippet`/`promptGuidelines` on the tool) | `prompts/tools/todo.md` |

**Execute flow** (port `TodoTool.execute` verbatim, `tools/todo.ts:857-896`):
1. `previous = clone(getTodoPhases())`; `storage = sessionFile ? "session" : "memory"`.
2. Resolve/repair params (`resolveTodoParams`), `op === "view"` → read-only.
3. `applyParams` on a clone; on any error, discard the batch wholesale (half-applied batch breaks retries — omp comment at :881-885).
4. On success: `setTodoPhases(updated)`; compute `completedTasks` via `getCompletionTransitions`.
5. Return `AgentToolResult` with `formatSummary` text + `details: { op, phases, storage, completedTasks? }` + `isError` on failure.

**Registration**: add to pi's tool set used by `createAgentSession` (alongside `createCodingTools` in core/sdk.ts); honor an `enabled` flag (omp `todo.enabled`, default true).

## Phase 2 — Session integration (`TodoTracker` in pi's AgentSession)

Port `session/todo-tracker.ts` (390 lines) as `src/core/todos/tracker.ts`. Host interface (omp `TodoTrackerHost`, todo-tracker.ts:46-60) mapped to pi:

| omp host member | pi source | Status |
|---|---|---|
| `agent` | `AgentSession.agent` | exists |
| `sessionManager` | `AgentSession.sessionManager` | exists |
| `settings` | `AgentSession.settingsManager` | exists (settings-manager.ts) |
| `model()` | `AgentSession.model` | exists |
| `agentKind()` | not present | stub → `"main"` (subagents out of scope) |
| `emitSessionEvent` | `AgentSession._emit` / `subscribe` | exists (agent-session.ts:563) |
| `scheduleAgentContinue` | no direct equivalent | **needs port**: omp appends developer message + `scheduleAgentContinue({generation})` to re-enter the loop; pi has `agent.appendMessage` + queue mechanisms (`agent_settled`, queued messages flush at `agent-session.ts:1102-1104`) — resolve during port; extension path: `ctx.sendMessage(…, { deliverAs: "nextTurn" })` |
| `promptGeneration()` | no equivalent | replace with a monotonic counter or drop (omp uses it to avoid stale continuations) |
| `hasPendingAsyncWake()` | n/a (no async jobs in todos-only port) | stub → `false` |
| `getActiveToolNames()` | pi `AgentSession` tracks active tools | exists (resource-loader/tool set) |
| `toolRegistry()` | pi tool map | exists |
| `planModeEnabled()` | no built-in plan mode (example extension only) | stub → `false`, or hook the plan-mode extension state |
| `consumeLastServedToolChoiceLabel()` | n/a | stub → `undefined` |

**Hook sites in pi's `AgentSession`** (map from omp `session/agent-session.ts`):

| Behavior | omp site | pi site | Notes |
|---|---|---|---|
| Eager prelude + forced tool_choice | `:5195-5198` (`createEagerTodoPrelude` before first prompt) | pre-prompt message assembly in pi's prompt path (`agent-loop`/`AgentSession.prompt`); inject custom message `display:false` + tool_choice | **most invasive change**; needs a pre-prompt hook pi doesn't expose today |
| Mid-run nudge | `:1210` (pre-prompt maintenance thunk) | same pre-prompt hook as above | `takeMidRunNudge` |
| Completion reminder | `:2964` (`checkCompletion` on terminal assistant turn) | pi `agent_end` handler (agent-session.ts:730-732); use `willRetry` guard | `checkCompletion` |
| Tool-result tracking | `:2386` (`onToolResult`) | pi `message_end`/`tool_result` handler (:502-505, :762) | `onToolResult`; also `onTodoResultDetails` for replan-title refresh (drop: no plan mode) |
| Branch sync | `:1344,6956,7624,7789,7882,8013,8341` (`syncFromBranch`) | pi load/rewind/compaction/session-switch paths (agent-session.ts has `session_tree` :3081, `compaction_end`, reload paths) | `syncFromBranch` |
| Cycle reset | `:5334,6530` (`resetCycle`) | prompt start | `resetCycle` |

**Persistence** (no new machinery): `syncFromBranch` = `getLatestTodoPhasesFromEntries(sessionManager.getBranch())` — pi's `ReadonlySessionManager.getBranch()` and toolResult `details` in branch entries already work (proven by pi's example todo.ts). Manual edits (`/todo`) additionally write `appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases })` like omp (todo-command-controller.ts:465).

## Phase 3 — Settings

Add to pi's `Settings` interface + defaults (core/settings-manager.ts / config): `todo.enabled` (bool, true), `todo.reminders` (bool, true), `todo.remindersMax` (num, 3), `todo.eager` (enum `default|preferred|always`). Expose in `/settings` UI if pi's settings schema supports custom entries (match pi's existing pattern; if the settings UI is schema-driven, register these — else accept plain config keys initially).

## Phase 4 — `/todo` command + HUD

- **`/todo` command** via `pi.registerCommand` (pi core/extensions, `ExtensionCommandContext`): port `todo-command-controller.ts` — view, fuzzy add/remove, `$EDITOR` edit with markdown round-trip, import/export, then `setTodoPhases` + `appendCustomEntry(user_todo_edit)` + system-reminder injection (`buildSystemReminder`, todo-command-controller.ts:119).
- **HUD widget** via `ctx.ui.setWidget(key, content|factory, options)` (core/extensions/types.ts:170): phase header (`I. Foundation`) + checkbox rows + progress (`done/total`). pi widgets live above/below the editor (docs/tui.md:793) — approximation of omp's sticky header; no strikethrough animation unless we build a custom widget component (pi supports component factories).
- **Reminder banner**: `todo_reminder` → `ctx.ui.notify` (info) or a widget swap; omp renders a dedicated banner component (modes/components/todo-reminder.ts).

## Phase 5 — Verification

**Unit tests** (port + adapt):
- `oh-my-pi/packages/coding-agent/test/tools/todo.test.ts` (999 lines) — pure op semantics: init/start/done/rm/drop/block/unblock/append/view, phase normalization, completion transitions, op inference, markdown round-trip, `getLatestTodoPhasesFromEntries` precedence (custom entry wins over toolResult? — preserve omp's scan order: newest-first, first match wins).
- `oh-my-pi/packages/coding-agent/test/modes/controllers/todo-command-controller.test.ts` (204 lines) — `/todo` command behavior.
- pi runs vitest (`vitest.base.ts`, per-package `vitest.config.ts`); follow pi's existing test layout (`src/…/*.test.ts` adjacent or `test/`).

**Integration checks** (each must pass before "done"):
1. Todo state survives session reload/rewind (syncFromBranch path).
2. `todo.eager: "always"` injects prelude + forced `todo` tool_choice on first message; `"preferred"` injects reminder only.
3. `checkCompletion` fires `<system-reminder>` and re-enters the loop when todos incomplete; respects `todo.remindersMax` and awaits-user guards.
4. Mid-run nudge after ≥12 mutating tool results (≤2/cycle).
5. `/todo export|import` markdown round-trips; `$EDITOR` edit path works.
6. Manual `/todo` edits persist as `user_todo_edit` custom entries and survive reload.
7. HUD widget renders phases/status; reminder banner appears.
8. `todo.enabled: false` removes the tool from the active set.

## Phase 6 — Risks / open questions

1. **Pre-prompt injection hook is the hard part.** omp injects preludes inside the session's prompt assembly with a forced tool choice. pi's `AgentSession`/`agent-loop` has no such hook today — the port must either add one (small, core change) or approximate with steering messages (`sendMessage`, `deliverAs`) that can't force a `tool_choice`. Forced choice matters for `eager: "always"`; without it the model may skip the todo call.
2. **`scheduleAgentContinue`** has no pi equivalent; continuation after reminder must reuse pi's queue/`agent_settled` machinery. Verify pi re-enters the loop after an appended message while idle.
3. **Plan mode**: pi's plan-mode is an example extension, not core. Decide: stub `planModeEnabled() → false` (todos work everywhere) or add an extension hook (todos pause in plan mode). Default: stub, note in README.
4. **Subagent reconcile / eager task prelude**: deliberately omitted (RESEARCH.md §2.3). When subagents arrive (harness lanes or in-process), re-add `#reconcileTodosWithSubagents` — it is already guarded by session kind and composes cleanly.
5. **Where the code ships**: `src/core/todos/` in pi-mono requires a pi PR (or a local patch). The example-extension route (`examples/extensions/`) avoids core changes but loses the eager prelude + forced choice; not chosen.
