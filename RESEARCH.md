# omp → pi: todos & subagents research

Research into how Oh My Pi (omp, fork of pi) builds its `todo` tool + tracker and its `task` (subagent) system, and whether they can be ported to pi (pi-mono). No code changes — evidence-based analysis only.

Sources (both cloned locally):
- `oh-my-pi/` — omp monorepo, `@oh-my-pi/pi-*` packages
- `pi-mono/` — pi monorepo, `@earendil-works/pi-*` packages

Fork relationship evidence:
- omp `packages/agent/package.json` credits Mario Zechner (pi's author) as contributor; repo `can1357/oh-my-pi` vs pi's `earendil-works/pi`.
- omp ships `extensibility/legacy-pi-ai-shim.ts` and `legacy-pi-coding-agent-shim.ts` for pi API compatibility.
- Version skew: omp `@oh-my-pi/pi-agent-core` 17.2.15 vs pi `@earendil-works/pi-agent-core` 0.84.1.

---

## Part 1 — How omp builds todos

Four layers: tool core → session state → persistence → behavior/UI.

### 1.1 Tool core — `oh-my-pi/packages/coding-agent/src/tools/todo.ts` (47 KB)

- **Ops**: `init | start | done | rm | drop | block | unblock | append | view` (`TodoOperation`, todo.ts:23). `TodoStatus`: `pending | in_progress | completed | abandoned | blocked` (todo.ts:21).
- **Pure state logic** — no I/O: `applyEntry` (todo.ts:485-556), `initPhases` (:395-429), `appendItems` (:431-464), `removeTasks` (:465-483), `getCompletionTransitions` (:125-144), `normalizeInProgressTask`, `nextActionableTask`.
- **`op` inference**: `inferTodoOp` (:567-574) repairs a missing `op` from the raw arg shape; `resolveTodoParams` (:584-595) re-validates at execute time. Tool sets `lenientArgValidation = true` (todo.ts:806).
- **Schema**: `@oh-my-pi/omptype` DSL (todo.ts:69-88). pi uses `typebox` — mechanical swap.
- **Markdown round-trip**: `phasesToMarkdown` (:636-652) / `markdownToPhases` (:667-715) — `/todo export|import` and manual file editing.
- **TUI renderer**: `todoToolRenderer` (:1120-1270) with completion strikethrough animation (`TODO_STRIKE_TOTAL_FRAMES`, `TODO_STRIKE_HOLD_FRAMES`), collapsed walking viewport (`selectCollapsedTodos` :332-344, `COLLAPSED_CLOSED_CONTEXT`), roman-numeral phase display (`phaseRomanNumeral`), dimmed closed-task counters.
- **`TodoTool` class** (:795-897): `AgentTool` from `@oh-my-pi/pi-agent-core`; `concurrency = "exclusive"`; execute reads `session.getTodoPhases()`, applies params, writes `session.setTodoPhases(updated)`, returns `TodoToolDetails = { op, phases, storage, completedTasks? }` (:57-63). Storage is `"session" | "memory"` keyed on `session.getSessionFile()` (:865).

### 1.2 Session state — `session/todo-tracker.ts` (390 lines)

- `AgentSession.#todo = new TodoTracker(host)` (agent-session.ts:1000).
- `TodoTracker` owns `#phases`, `#reminderCount`, `#reminderAwaitingProgress`, `#mutationsSinceLastTouch`, `#midRunNudgeCount`.
- Exposed via `ToolSession.getTodoPhases()/setTodoPhases()` (agent-session.ts:6252-6258; tools/index.ts:327-330).
- `TodoTrackerHost` interface (todo-tracker.ts:46-60): `agent`, `sessionManager`, `settings`, `model()`, `agentKind()`, `emitSessionEvent()`, `scheduleAgentContinue()`, `promptGeneration()`, `hasPendingAsyncWake()`, `getActiveToolNames()`, `toolRegistry()`, `planModeEnabled()`, `consumeLastServedToolChoiceLabel()`.

### 1.3 Persistence — branch replay (two sources)

`getLatestTodoPhasesFromEntries(entries)` (todo.ts:177-198) scans the session branch **backward** for:
1. the latest explicit custom entry `USER_TODO_EDIT_CUSTOM_TYPE = "user_todo_edit"` (`{ phases }`) — written by `/todo` edits, cursor sync, tan-clone reset (todo-command-controller.ts:465, sdk.ts:2786, slash-commands/helpers/todo.ts:100); or
2. the latest successful `todo` toolResult message's `details.phases` (todo.ts:187-194) — **the tool result itself is the durable record**.

`#todo.syncFromBranch()` replays state on load, rewind, compaction, session switch, re-parent (agent-session.ts:1344, 6956, 7624, 7789, 7882, 8013, 8341).

### 1.4 Behavioral layer — `TodoTracker` methods

- **Eager todo prelude** (`createEagerTodoPrelude`, todo-tracker.ts:130-165): on first message, if `todo.eager` is `preferred|always` and no todos exist and not plan mode, injects a `role: "custom"` display-hidden message; at `always` also forces a `todo` tool_choice (`buildNamedToolChoice("todo", model)`). Guards: prompt ends with `?`/`!`, existing user messages, `todo` not in active tools.
- **Mid-run nudges** (`takeMidRunNudge`, :287-316): after ≥12 mutating tool results (`MID_RUN_NUDGE_MUTATION_THRESHOLD`), ≤2 per cycle, injects `mid-run-todo-nudge` custom message.
- **Completion reminders** (`checkCompletion`, :198-284): on terminal assistant turn with incomplete todos, emits `todo_reminder` session event, appends a `<system-reminder>` developer message (`"You stopped with N incomplete todo item(s)… (Reminder k/max)"`), schedules agent continue. Guards: plan mode, user-force tool choice, awaiting user answer, async jobs in flight, `todo.reminders`/`todo.remindersMax`.
- **Post-compaction nudges** (`buildPostCompactionEagerNudges`, :188-195).
- **Eager task prelude** (`createEagerTaskPrelude`, :168-185): **task-dependent but self-disabling** — returns `undefined` unless `task.eager === "always"` AND `"task"` in active tools.

### 1.5 Settings — `config/settings-schema.ts`

| Path | Type | Default | Notes |
|---|---|---|---|
| `todo.enabled` | boolean | true | gates tool availability (settings-schema.ts:3719) |
| `todo.reminders` | boolean | true | (:3730) |
| `todo.remindersMax` | number | 3 | renamed from `todo.reminders.max` (settings.ts:191) |
| `todo.eager` | enum | `default` | `default|preferred|always` (:3758) |
| `todo.autoClearDelay` | number | — | HUD auto-clear of closed todos (:4760 area) |

### 1.6 UI layer (omp-specific glue)

- Sticky Todos HUD in interactive mode: `modes/interactive-mode.ts` — `todoPhases` field (:530), `#renderTodoList`, `#loadTodoList` (:2267), `#reconcileTodosWithSubagents` (:2020), `#syncTodoAutoClearTimer`.
- `/todo` command: `modes/controllers/todo-command-controller.ts` — view, edit in `$EDITOR`, import/export markdown, fuzzy add/drop, system-reminder injection after manual edits.
- `todo_reminder` event → `TodoReminderComponent` (modes/components/todo-reminder.ts) via event-controller.
- Displaceable live todo panels: `modes/components/tool-execution.ts` (`#updateTodoStrikeAnimation`), `chat-transcript-builder.ts`, `event-controller.ts` `#displaceableTodoComponent`.
- Plan-mode integration: `todoMatchesAnyDescription` used to light up todos matched to live subagent descriptions.

---

## Part 2 — omp subagents (context for independence)

### 2.1 Task tool — `packages/coding-agent/src/task/` (index.ts 58 KB, executor.ts 127 KB)

- **In-process spawns**: each subagent is a real `AgentSession` built via `createAgentSession` (executor.ts:3129) with its own JSONL session file in the artifacts dir (executor.ts:2686-2690), `createSubagentSettings` (setting overrides), per-agent tool list (auto-adds `task` unless at `task.maxRecursionDepth`, default 2; always adds `hub`), model override, effort hint, driven to completion by `driveSessionToYield` (executor.ts:1860) under a run monitor (abort/timeout/soft request budget, `SOFT_REQUEST_BUDGET`).
- **Result contract**: `yield` tool (`tools/yield.ts`) — subagent submits `{result:{data}}` validated against an `outputSchema` (permissive/strict, in-tool retry budget, `schema_violation` non-zero exit).
- **Structured output**: `structured-subagent.ts` — schema resolution (caller/agent/session), isolation controls.
- **Batch**: `task.batch` setting — one call `{ context, tasks[] }` → parallel spawns, shared context, semaphore-bounded (`task.maxConcurrency`, `task/parallel.ts`).
- **Async**: `async.enabled` → background jobs (`async/job-manager.ts`) with idle-TTL parking (`task.agentIdleTtlMs`) and **persisted revive** (persisted-revive.ts reopens JSONL → `createAgentSession`).
- **Isolation**: `isolation-runner.ts` + `worktree/` — git worktree per spawn, merge patch/branch.
- **Discovery**: `discovery.ts` — bundled agents + `~/.omp/agent/agents/*.md` + `.omp/agents/*.md` + extension roots; markdown+YAML frontmatter (`AgentDefinition`).
- **UI**: `task/render.ts` — JSON progress channels (`TASK_SUBAGENT_EVENT_CHANNEL` etc.), live parallel rendering, per-task tokens/cost.

### 2.2 Coordination — hub + IRCBus + registry

- `tools/hub/{index,jobs,messaging,launch}.ts` — one tool surface: peer messaging (`send`/`inbox`/`list`/`wait`), job lifecycle (`jobs`/`cancel`), process supervision (`start`/`ps`/`logs`/`stop`/`restart`/`describe`).
- `irc/bus.ts` — IRC-style message bus between live agents.
- `registry/agent-registry.ts`, `agent-lifecycle.ts`, `persisted-agents.ts` — global registry, idle parking, status sync.

### 2.3 Independence analysis: todo ↔ subagent coupling

**Todo → subagent: essentially none.** Verified imports:
- `tools/todo.ts` imports only omptype, pi-agent-core types, render-utils, theme. No `task/`, no hub, no registry.
- `session/todo-tracker.ts` imports only pi-agent-core, pi-ai, pi-utils, settings, prompts, `tools/todo`, tool-choice, session-manager. The only `task` reference is `createEagerTaskPrelude`, which self-disables without a task tool (guards on `task.eager === "always"` **and** `"task"` in active tools — todo-tracker.ts:168-176).

**Subagent → todo: two additive, guarded touchpoints in interactive-mode.ts:**
- `setActiveTodoDescriptionsProvider(() => this.#getActiveSubagentDescriptions())` (:1070) — lights up todos matched to in-flight subagent work; empty without subagent sessions.
- `#reconcileTodosWithSubagents()` (:2020) — auto-completes todos whose content matches a finished subagent's description; guarded by `session.kind !== "subagent" → continue` — no-op without subagents.

**Verdict**: todos port cleanly to pi without any subagent machinery. The subagent-reconcile features compose later by un-guarding.

---

## Part 3 — pi's current state

### 3.1 What pi has

- **No built-in `todo` or `task` tool** — `grep "class TodoTool|class TaskTool|todoSchema|taskSchema" pi-mono/packages` → no matches in `src/`.
- **Example extensions** (`pi-mono/packages/coding-agent/examples/extensions/`):
  - `todo.ts` — flat list tool (`list|add|toggle|clear`), `/todos` command, state reconstructed by scanning toolResult `details` on the branch via `ctx.sessionManager.getBranch()` — **the same persistence primitive omp uses**. Rendered via `renderCall`/`renderResult` returning pi-tui components.
  - `plan-mode/` — `/plan`, `/todos`, todo extraction from assistant message, widget `ctx.ui.setWidget("plan-todos", lines)`.
  - `subagent/` (35 KB) — **spawns a separate `pi --mode json -p --no-session` process per agent** (index.ts:300, 346), single/parallel (8 tasks, 4 concurrent)/chain modes, discovery from `~/.pi/agent/agents` + opt-in `.pi/agents`, abort propagation, 50 KB per-task output cap, live streaming UI.
- **Harness (lanes) is spec + partial implementation**: `packages/agent/src/harness/` — session storage layer (memory/jsonl) implements lanes + custom entries with conformance tests (`session/state.ts`, `jsonl/storage.ts`, `testing/conformance.ts`); but `AgentHarness.create()` throws `HarnessNotImplemented("create.restore")` and `createLane()` returns `unavailable("createLane")` (agent-harness.ts:347, 447-451). harness.md:98: lanes designed for "Slack threads, **subagents**, and other parallel work". Recent git history is `docs(agent):` — runtime track unbuilt.
- **Interactive mode runs the legacy runtime**: `createAgentSession` (core/sdk.ts:169) → `AgentSession` (core/agent-session.ts, 110 KB).

### 3.2 API contract parity (verified)

| Contract | omp | pi |
|---|---|---|
| `AgentTool` | `@oh-my-pi/pi-agent-core` (fork) | `@earendil-works/pi-agent-core` (agent/src/types.ts:386) — same shape |
| execute | `(toolCallId, params, signal, onUpdate, _ctx) → AgentToolResult<T>` | `ToolDefinition.execute(toolCallId, params, signal, onUpdate, ctx: ExtensionContext)` (core/extensions/types.ts:480-486) |
| `AgentToolResult<T>` | `{ content, details?, isError? }` | identical (agent/src/types.ts:361) |
| schema | omptype | typebox (`Type.Object`/`StringEnum`) |
| session persistence | `sessionManager.appendCustomEntry`, `getBranch()` | identical (ReadonlySessionManager; example todo.ts proves it) |
| custom rendering | `todoToolRenderer` | `renderCall`/`renderResult` → pi-tui `Component` |
| arg repair | `lenientArgValidation` + `resolveTodoParams` | `prepareArguments` shim (core/extensions/types.ts:468) |
| exclusive concurrency | `concurrency = "exclusive"` | `executionMode` (types.ts:477) |

### 3.3 pi `AgentSession` event surface (for the tracker port)

`AgentSessionEvent` (core/agent-session.ts:141-147): `agent_end` (with `willRetry`), `message_start/update/end`, `turn_start/end`, `tool_execution_start/update/end`, `compaction_start/end`, `session_start/tree/info_changed`, `agent_settled`, `auto_retry_*`, `queue_update`. `subscribe(listener)` (agent-session.ts:815). Extensions reach these via `pi.on(...)` → `_extensionRunner.emit(...)` (agent-session.ts:730-807).

---

## Part 4 — Portability analysis

### 4.1 Todos → pi: HIGH (≈1 week)

- Tool core ~95% pure logic; `AgentTool`/`ToolDefinition` contract identical; omptype→typebox mechanical; branch replay already proven by pi's own example extension.
- Work: `TodoTracker`-equivalent hooks in pi's `AgentSession` (~10 call sites: `checkCompletion` on agent_end, `onToolResult` on tool_result, `syncFromBranch` on load/rewind/compaction, eager prelude pre-prompt), settings entries, `/todo` command, HUD widget. pi has the same lifecycle events, `appendCustomEntry`, `getBranch()`, `ui.setWidget`.

### 4.2 Subagents → pi: full parity LOW (weeks); useful subset already ships

- pi's example extension already covers isolated contexts, parallel spawns + concurrency, chains, discovery + trust model, live UI, aborts.
- omp in-process machinery is portable in principle (pi's `AgentSession` is the fork ancestor; `createAgentSession` accepts `tools`/`model`/`sessionManager`), but requires the whole executor (127 KB) plus genuinely new infrastructure: `yield` tool + schema enforcement, IRCBus/hub messaging, AgentRegistry + parking + persisted revive, async job manager, worktree isolation, depth caps, progress channels.
- The designed substrate (harness lanes) is where pi planned subagents but is unimplemented — a port today builds on the legacy `AgentSession`, as omp did.

### 4.3 Dependency matrix for the todos port

| omp module | pi equivalent | Delta |
|---|---|---|
| `tools/todo.ts` (pure core) | — | port as-is; omptype → typebox |
| `tools/todo.ts` (renderer) | pi-tui `Component`, `theme` | port; adapt imports |
| `TodoTracker` | none | port; needs `TodoTrackerHost`-like host on pi's AgentSession |
| `session.getTodoPhases/setTodoPhases` | none | add to pi's AgentSession (or extension-module state) |
| branch replay | `SessionManager.getBranch()` + toolResult details + custom entries | works today |
| `todo.*` settings | `SettingsManager` | add defaults + `/settings` entries |
| `/todo` command | `pi.registerCommand` | port controller |
| HUD | `ctx.ui.setWidget` (above/below editor) | port; no sticky-header equivalent (omp-specific) |
| `todo_reminder` event + banner | `ctx.ui.notify` / widget | adapt |
| eager prelude (forced tool choice) | no direct extension API | needs core hook (agent-session pre-prompt) or steer-message approximation |
| subagent reconcile (`#reconcileTodosWithSubagents`) | — | **omit** (or keep inert) |
| eager task prelude (`createEagerTaskPrelude`) | — | **omit** (self-disables anyway) |

---

## Part 5 — Evidence index (key file:line references)

### omp
- `packages/coding-agent/src/tools/todo.ts` — types :21-63, schema :69-88, ops :395-616, markdown :618-715, `TodoTool` :795-897, renderer :899-1270, `getLatestTodoPhasesFromEntries` :177-198
- `packages/coding-agent/src/session/todo-tracker.ts` — host :46-60, eager todo :130-165, eager task :168-185, nudges :287-316, reminders :198-284
- `packages/coding-agent/src/session/agent-session.ts` — `#todo` :1000, prelude injection :5195-5198, nudge thunk :1210, `checkCompletion` :2964, sync sites :1344/6956/7624/7789/7882/8013/8341, get/set :6252-6258
- `packages/coding-agent/src/config/settings-schema.ts` — todo settings :3718-3777, auto-clear :4760
- `packages/coding-agent/src/modes/interactive-mode.ts` — HUD :530/1070/2020/2267
- `packages/coding-agent/src/modes/controllers/todo-command-controller.ts` — /todo command
- `packages/coding-agent/src/tools/index.ts:437` — `todo: s => new TodoTool(s)`
- `packages/coding-agent/src/task/` — executor.ts:3129 (createAgentSession), :2686-2690 (session file), :1860 (driveSessionToYield); index.ts; discovery.ts; yield tool in tools/yield.ts; hub in tools/hub/

### pi
- `packages/agent/src/types.ts:386-402` — `AgentTool` interface
- `packages/coding-agent/src/core/extensions/types.ts:307-347` — `ExtensionContext`; :449-498 — `ToolDefinition`; :131-174 — `ExtensionUIContext` (`setWidget`)
- `packages/coding-agent/src/core/agent-session.ts:141-147` — events; :815 — `subscribe`; :730-807 — extension event dispatch
- `packages/coding-agent/examples/extensions/todo.ts` — state-in-details persistence pattern
- `packages/coding-agent/examples/extensions/subagent/index.ts:300,346` — process-per-subagent spawn
- `packages/agent/src/harness/agent-harness.ts:347,447-451` — unimplemented lanes
- `packages/agent/docs/harness.md:98` — lanes for subagents (design)
