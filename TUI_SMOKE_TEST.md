# Manual TUI smoke tests

Terminal-rendering and live-interaction behavior cannot be fully verified in
unit tests. Before a release, run this checklist in a real pi session with a
working model and record the results.

Setup: `pi install npm:@gamaraan/todos` (or add the extension path to
`~/.pi/agent/settings.json`), restart pi.

## 1. Tool registration and basic flow

- [ ] Ask the agent to "plan and implement X in 3 phases" — it calls `todo`
      with `init` and a phased list; the result renders with roman-numeral
      phase headers (`I. Foundation`), checkboxes, and progress (`1/3`).
- [ ] Completing a task renders it struck through; the next pending task
      auto-promotes and renders in accent color.
- [ ] The tool result view collapses untouched phases to a one-line summary;
      pressing the expand key (default `ctrl+e` in the tool view) shows all.

## 2. Persistence across reload/rewind

- [ ] Ask the agent to create todos, then `/new` or restart pi and resume the
      session — the HUD and `/todo` show the same list.
- [ ] Ask the agent to complete a task, then rewind the session tree to
      before the completion (`/tree` navigation) — the todo state matches the
      earlier point.

## 3. HUD widget

- [ ] With todos present, a compact checklist widget with `N/M done` shows
      above the editor and updates after every `todo` tool result and every
      `/todo` command.
- [ ] After `/todo rm` (all), the widget disappears.
- [ ] No widget in `--mode json` / `-p` runs.

## 4. `/todo` command

- [ ] `/todo` shows the current list as Markdown.
- [ ] `/todo append Wire up CI` adds a task to the last phase (single-task
      form) and `/todo append Auth Port OAuth` adds to a phase (auto-created
      when missing).
- [ ] `/todo start ci` fuzzy-starts the task; `/todo done ci` completes it.
- [ ] `/todo edit` opens the built-in editor; editing the Markdown and
      saving updates the list, and the next agent turn acknowledges the
      manual change (hidden reminder).
- [ ] `/todo export` writes `TODO.md`; `/todo rm` then `/todo import` restores
      the exported list.
- [ ] `/todo copy` puts the Markdown on the clipboard (OSC 52; verify paste).
- [ ] `/todo rm (all)` followed by an agent turn — the agent does NOT
      recreate the list on its own.

## 5. Eager prelude

- [ ] Set `"eager": "preferred"` in `~/.pi/agent/todo.json`, restart, and
      start a new session with a multi-step request — the agent opens with a
      phased `todo init` (or at least mentions planning).
- [ ] With `"eager": "always"`, the first turn of a NEW session (no prior
      user messages) starts with a `todo` call; a question prompt
      ("Can you review this?") does not trigger it.
- [ ] Resume an existing session — no prelude injected.

## 6. Mid-run nudge

- [ ] With an incomplete todo list, ask the agent to perform many small edits
      (12+ successful `edit`/`write` calls without touching `todo`) — a
      hidden steer message appears mid-run asking it to mark finished tasks
      done (≤2 per cycle). Hard to observe directly; verify via a session
      where the agent's output suddenly includes a `todo done` call after
      many mutations.

## 7. Completion reminder

- [ ] Ask the agent to do a multi-step task, then stop it early (or let it
      finish with incomplete todos) — a reminder notification appears and the
      agent resumes with a fresh turn listing the remaining items.
- [ ] The reminder does not fire when the agent ends with a question
      ("Should I continue?") or when all todos are complete.
- [ ] With `"reminders": false` in `todo.json`, no reminder fires.
- [ ] With `"remindersMax": 0`, no reminder fires.

## 8. Disabled

- [ ] With `"enabled": false` in `~/.pi/agent/todo.json`, restart — the
      `todo` tool is absent from `/tools`, no prelude/reminders/nudges fire,
      and `/todo` commands still work for manual lists.

## Record

| Date | pi version | Result | Notes |
| --- | --- | --- | --- |
