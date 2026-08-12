# @gamaraan/todos — OMP-style todos for pi

A [pi](https://github.com/earendil-works/pi-coding-agent) coding-agent
extension that ports the **Oh My Pi (OMP) todo tool, tracker, and `/todo`
command** to pi as a self-contained extension package: a phased todo list the
agent plans and updates itself, with completion reminders, an eager first-turn
prelude, a `/todo` slash command, and a persistent HUD widget.

```
Todo  2/5 done
  I. Foundation 1/2
    ✓ Scaffold crate
    ○ Wire workspace
  II. Auth 1/3
    ○ Port credential store
```

## Features

**The `todo` tool** (for the agent): `init | start | done | rm | drop | block |
unblock | append | view`.

- Phased lists (`init` with `list: [{phase, items}]` or a flattened
  `items: [...]`), tasks referenced **by exact content, never IDs**.
- The earliest still-open task auto-promotes to `in_progress` after every
  completion; out-of-order completion is handled (completed tasks never
  revert).
- `block`/`unblock` for work waiting on external input — blocked tasks are
  excluded from stop-time reminders and carry an optional `reason` that
  survives the Markdown round-trip.
- Strict batch semantics: a failing batch is discarded wholesale, so a model
  retry never hits "already exists" for ops that partially landed.
- Missing `op` is inferred for unambiguous shapes (`{list:...}` → `init`,
  `{phase, items}` → `append`, bare `items` on an empty list → `init`) via
  the tool's `prepareArguments` shim.
- Custom TUI rendering: roman-numeral phase headers, progress counters,
  status-colored checkboxes, strikethrough completions, and a walking
  collapsed viewport that keeps the just-completed task visible while
  collapsing untouched phases.

**The tracker** (session behavior):

- **Eager prelude** — with `todo.eager: "preferred" | "always"`, the first
  turn of a session injects a hidden reminder asking the model to lay out a
  phased plan with a single `init` call before working. Guards: skipped for
  questions/exclamations, when todos already exist, or when the tool is not
  active. pi's extension API cannot force a `tool_choice`, so `"always"`
  injects a MUST-call reminder instead (see Differences from OMP).
- **Mid-run nudge** — after 12 successful mutating tool results (bash/edit/
  write/eval) with incomplete todos, a hidden steer message asks the agent to
  mark finished tasks done (≤2 per prompt cycle).
- **Completion reminder** — when the agent settles with incomplete todos and
  isn't waiting for user input, a reminder listing the remaining items is
  injected and a fresh turn is triggered (`todo.reminders`,
  `todo.remindersMax`, default 3). Reminders pause until the agent makes
  progress (any tool result) and never fire while the assistant is awaiting
  your answer.

**The `/todo` command** (for you):

```text
/todo                              Show current todos
/todo edit                         Edit todos in the built-in editor
/todo copy                         Copy todos as Markdown (OSC 52 clipboard)
/todo export [<path>]              Write todos to a file (default: TODO.md)
/todo import [<path>]              Replace todos from a file
/todo append [<phase>] <task...>   Append a task (phase fuzzy-matched/created)
/todo start  <task>                Mark a task in_progress (fuzzy match)
/todo done/drop [<task|phase>]     Mark completed / abandoned
/todo rm     [<task|phase>]        Remove task/phase/all
```

Manual edits persist as `user_todo_edit` custom entries (they win over tool
results when newer) and inject a hidden reminder telling the model what
changed — including explicit "do NOT recreate" directives after removals.
Outside the TUI, `/todo edit` falls back to `$VISUAL`/`$EDITOR` on a temp
file.

**The HUD widget** — a compact per-phase checklist with progress
(`2/5 done`), rendered above the editor and kept in sync with every tool
result, manual edit, and session reload.

## Install

The published package is `@gamaraan/todos`:

```bash
pi install npm:@gamaraan/todos
```

Pin a release with `pi install npm:@gamaraan/todos@0.1.0`. From GitHub:
`pi install git:github.com/gamaraan/todos-tool-pi-extension`. Manual: copy
`src/index.ts` (plus the `src/` modules it imports) into
`~/.pi/agent/extensions/`, or add the path to the `extensions` array in
`~/.pi/agent/settings.json`. Restart pi (or start a new session) after
installing.

## Configure

The extension cannot extend pi's built-in settings schema, so it reads a
small JSON file from the host agent dir, optionally overridden per project:

| File | Scope |
| --- | --- |
| `~/.pi/agent/todo.json` | Global |
| `<cwd>/.pi/todo.json` | Project (only when the project is trusted) |

```json
{
  "enabled": true,
  "reminders": true,
  "remindersMax": 3,
  "eager": "default"
}
```

| Key | Default | Notes |
| --- | --- | --- |
| `enabled` | `true` | Gates the tool and all tracker behaviors. When `false` the `todo` tool is removed from the active tool set at session start. A global `false` is a floor — project config cannot re-enable it. |
| `reminders` | `true` | Stop-time incomplete-todo reminders. |
| `remindersMax` | `3` | Max reminder attempts per prompt cycle. |
| `eager` | `"default"` | `"default"` = no prelude, `"preferred"` = soft reminder, `"always"` = MUST-call reminder on the first turn. |

Invalid values and unknown keys are ignored with a warning; config is loaded
at session start (restart or `/reload` to pick up changes).

## How it works

- **Persistence is the tool result itself.** Every successful `todo` result
  carries `details.phases`; on session start, rewind (`session_tree`), and
  compaction, the extension replays the branch (`getLatestTodoPhasesFromEntries`)
  and takes the newest snapshot — the latest `user_todo_edit` custom entry,
  else the latest successful `todo` toolResult. Branching and rewinding
  always show the todo state correct for that point in history.
- **Errors are thrown.** pi signals tool failures by throwing; the model
  receives the omp-style summary text (errors + full current list) and the
  previous state stays intact.
- **Reminders re-enter the loop** via `pi.sendMessage(..., { triggerTurn: true })`
  from the `agent_settled` handler; mid-run nudges use `deliverAs: "steer"`.

## Compatibility

**Pi:** supported range **0.84.x** (the API surface this extension uses —
`ToolDefinition.prepareArguments`, `before_agent_start` message injection,
`agent_settled`, `sendMessage` with `triggerTurn`/`deliverAs` — is current
for 0.84.0+). CI runs the unit suite and typecheck against the pinned
published packages.

**OMP:** not supported, by design — OMP ships its own native `todo` tool, so
loading this extension there would register a duplicate tool name. The port
target is pi only.

## Differences from OMP

Faithful port, with these deliberate adaptations:

| OMP | This extension |
| --- | --- |
| `todo.eager: "always"` forces a `tool_choice` | pi extensions cannot force tool choices; `"always"` injects a MUST-call reminder (models virtually always comply) |
| Sticky HUD header at the top of the chat | HUD widget above the editor (`ctx.ui.setWidget`) |
| Strikethrough reveal animation driven by the spinner frame | Completed tasks strike through immediately (pi render options carry no frame counter) |
| Settings via OMP's settings schema (`todo.*`) | `todo.json` config files (global + trusted project) |
| `$EDITOR` for `/todo edit` | Built-in pi editor dialog in the TUI; `$EDITOR` fallback outside it |
| Plan-mode pause, subagent reconciliation, eager task prelude | Out of scope (pi has no core plan mode / subagents); the guarded hooks are omitted |
| `<system-reminder>` as a `developer` message | Same text as a hidden `custom` message (pi converts these to user-role in context — the only injection mechanism extensions have) |

## Develop

```bash
bun install
bun run typecheck        # tsc --noEmit against the published pi 0.84.1 types
bun test                 # 149 unit tests across state/markdown/persistence/format/render/tracker/command/config/smoke
bun run verify:package   # npm pack --dry-run
```

The extension imports `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`,
and `@earendil-works/pi-ai` (peer dependencies, provided by your pi
installation). The `src/` modules are loaded by pi's extension loader (jiti)
directly as TypeScript — no build step.

See [`AGENTS.md`](./AGENTS.md) for the development guide — architecture,
conventions, and the pre-release manual smoke checklist.

## License

MIT — see [LICENSE](./LICENSE). This project ports code from
[Oh My Pi](https://github.com/oh-my-pi) (MIT, © Can Bölük) which is itself a
fork of [pi](https://github.com/earendil-works/pi-coding-agent) (MIT,
© Mario Zechner); both copyright notices are retained.
