# Desktop-notify integration plan

## Goal

Allow `@gamaraan/todos-tool` 0.2.0 to request best-effort desktop notifications
when a todo is completed or blocked in an interactive TUI session. The
extension must remain fully standalone: it cannot require, import, install, or
probe `@gamaraan/desktop-notify`.

## Compatibility contract

- Use only pi's EventBus channel:
  `pi.events.emit("desktop-notify:request", payload)`.
- Do **not** add `@gamaraan/desktop-notify` to any dependency section, import
  it statically or dynamically, inspect its installation, or change its
  configuration.
- Emit only from successful TUI state mutations. Session replay, session
  start/tree/compact synchronization, failed/atomic-rejected operations,
  read-only `view`, print/JSON/RPC contexts, and a missing EventBus listener
  must remain silent.
- Detect transitions from an active state to `completed` or `blocked`; do not
  notify again for an already completed/blocked task.
- Use plain payloads composed locally, with no imported sibling types:
  - completion: `{ title: "Todo", body: "Completed N todo task(s)", type: "todo-completed", urgency: "normal", sound: "info" }`
  - blocked: `{ title: "Todo", body: "Blocked N todo task(s)", type: "todo-blocked", urgency: "normal", sound: "warning" }`
- Keep task text and blocker reasons out of notification payloads. This makes
  payload sizing predictable and avoids disclosing project details in desktop
  toasts.
- Preserve current HUD, persistence, custom-entry, reminder, and `/todo`
  behavior whether or not desktop-notify is loaded.

## Implementation tasks

### 1. Isolate state-transition notification derivation

**Files:** add a small pure helper under `src/` (for example
`src/notifications.ts`) and its focused unit test.

1. Accept previous and next `TodoPhase[]` snapshots and derive the counts of
   newly completed and newly blocked tasks using the stable phase/task identity
   rules already used by todo state operations.
2. Return zero, one, or two documented plain EventBus payloads. Preserve a
   deterministic ordering when one mutation creates both transition types.
3. Treat removed tasks, replayed/imported baseline state, and unchanged
   terminal states as non-events.

**Tests to add:**

- A direct unit test covers a single completion, a single block, multiple
  transitions with pluralized counts, and deterministic payload order.
- Negative cases cover unchanged completed/blocked items, read-only snapshots,
  removed tasks, and inputs with no active-to-terminal transition.

**Definition of done:**

- Notification payload creation is pure, has no pi or desktop-notify import,
  and produces only the documented bounded, task-text-free payloads.
- All positive and negative helper tests pass.

### 2. Emit requests from successful interactive mutation paths

**Files:** `src/index.ts`; update `src/command.ts` only if the command host
needs a narrow callback to report a successfully committed transition.

1. Capture the pre-mutation snapshot and, after a successful `todo` tool
   operation, derive and emit notifications only when `ctx.mode === "tui"` and
   `ctx.hasUI` is true.
2. Route successful `/todo` mutations through the same derivation/emission
   seam so tool and command changes follow one contract. Do not emit during
   display, export, copy, or failed command handling.
3. Keep lifecycle synchronization (`session_start`, `session_tree`, and
   `session_compact`) notification-free. EventBus delivery must be
   fire-and-forget: no listener result or failure may alter the completed
   mutation, HUD update, persistence entry, or agent flow.

**Tests to add/update:**

- Extend `test/smoke.test.ts`'s recording API to capture `events.emit`, then
  dispatch real TUI tool operations that complete and block tasks; assert the
  exact channel, payload, count, and one emission per newly terminal task
  group.
- Add command-path coverage in `test/command.test.ts` or smoke coverage,
  asserting a successful `/todo` terminal-state mutation uses the same
  callback/payload contract.
- Pin silent paths: print/JSON/RPC contexts, `view`, failed operations,
  repeated terminal operations, and session branch rehydration emit nothing.

**Definition of done:**

- Both mutation surfaces emit only the documented EventBus requests for new
  completion/block transitions in a TUI session.
- Existing command notifications, tool results, persistence records, HUD
  updates, and reminder behavior are unchanged.
- The extension completes normally when `events.emit` has no consumer.

### 3. Document the optional integration and prepare the 0.2.0 release

**Files:** `README.md`, `package.json`, and any lock/package metadata that
actually records this package's own version.

1. Document the completion/block EventBus behavior, the payload privacy rule,
   and that desktop-notify is optional and best-effort.
2. Explain that desktop-notify configuration controls delivery when it is
   present; todos-tool does not add a dependency or its own notifier settings.
3. Change the package version from `0.1.0` to `0.2.0` without unrelated
   dependency upgrades.

**Tests to add/update:**

- Add or extend a package/discovery assertion to pin `0.2.0` while retaining
  todo tool and command registration.
- Use `npm pack --dry-run --json` to review the release artifact and rendered
  README; only add a README text assertion if this repository adopts one as a
  normal test convention.

**Definition of done:**

- Version metadata is exactly `0.2.0`, and the README does not imply that
  desktop-notify is installed or required.
- No desktop-notify package dependency, import, or installation instruction
  was added.

## Final verification

Run after all implementation tasks are complete:

```bash
bun run typecheck
bun test
bun run verify:package
```

Then use the real pi binary with a sandboxed `PI_CODING_AGENT_DIR` to load the
packaged extension in two TUI sessions: one without desktop-notify (todo tool,
HUD, reminders, and `/todo` must work normally) and one with desktop-notify
loaded (one completion and one blocked transition must request the documented
notifications). Confirm that print/JSON/RPC modes and branch replay remain
silent, and rerun the pre-release manual smoke checklist in `AGENTS.md`.

## Overall definition of done

- todos-tool is released as version `0.2.0` with EventBus-only completion and
  blocked-task notification requests.
- The package remains loadable and fully functional without desktop-notify;
  the absent-listener path has no observable behavior change.
- All new transition, integration, command, regression, typecheck, test,
  package, and manual two-extension/no-listener verification gates pass.
