/**
 * Prompt text for the todo tool and the tracker's injected messages.
 *
 * Ported from Oh My Pi's `packages/coding-agent/src/prompts/tools/todo.md`,
 * `src/prompts/system/eager-todo.md`, and
 * `src/prompts/system/mid-run-todo-nudge.md` (Handlebars templates flattened
 * to plain template functions — the extension cannot rely on omp's prompt
 * renderer).
 */

export interface EagerTodoContext {
	/** Wire name of the todo tool (normally "todo"). */
	toolRef: string;
	/** Whether the eager mode is "always" (MUST-call) vs "preferred". */
	forced: boolean;
}

/** First-turn eager todo prelude (`todo.eager: "preferred" | "always"`). */
export function renderEagerTodoPrompt(context: EagerTodoContext): string {
	const { toolRef, forced } = context;
	if (forced) {
		return (
			`<system-reminder>\n` +
			`Before substantive work, create a phased todo.\n\n` +
			`You MUST call \`${toolRef}\` first in this turn.\n` +
			`You MUST initialize the todo list with a single \`init\` op.\n` +
			`You MUST cover the entire request from investigation through implementation and verification — not just the next immediate step.\n` +
			`Task descriptions MUST be concise, specific 5-10 word labels.\n` +
			`The \`init\` op only accepts phase names and task-label strings; do not invent task metadata fields.\n\n` +
			`After \`${toolRef}\` succeeds, continue the request in the same turn.\n` +
			`NEVER call \`${toolRef}\` again unless task state has materially changed.\n` +
			`</system-reminder>`
		);
	}
	return (
		`<system-reminder>\n` +
		`Consider calling \`${toolRef}\` first to lay out a phased plan with a single \`init\` op. A good list covers the whole request — investigation through implementation and verification — not just the next step, with specific task descriptions a future turn could execute without re-planning.\n` +
		`A useful list keeps each task to a concise, specific 5-10 word label; the \`init\` op only accepts phase names and task-label strings, so don't invent extra task metadata fields.\n` +
		`If you create the list, continue the request in the same turn and avoid re-calling \`${toolRef}\` unless task state materially changes.\n` +
		`</system-reminder>`
	);
}

export interface MidRunNudgeContext {
	/** Wire name of the todo tool (normally "todo"). */
	toolRef: string;
	incompleteCount: number;
}

/** Hidden mid-run nudge injected after many mutating tool results. */
export function renderMidRunNudgePrompt(context: MidRunNudgeContext): string {
	const { toolRef, incompleteCount } = context;
	const plural = incompleteCount !== 1;
	return (
		`<system-reminder>\n` +
		`${incompleteCount} todo item${plural ? "s" : ""} still open. If you finished a task since last \`${toolRef}\` update, mark it done now so progress stays visible; otherwise keep working.\n` +
		`</system-reminder>`
	);
}

/** The todo tool's description (what the model sees in the tools section). */
export const TODO_TOOL_DESCRIPTION = `**Tasks: verbatim content strings, NEVER auto-generated IDs; no "task-1"/"task-N". Pass content in \`task\`.**

Each completion: earliest still-open task (phase order) auto-promotes to \`in_progress\`. Out-of-order completion may move pointer back to an earlier phase—expected; completed tasks NEVER revert.

## Operations

|\`op\`|Fields|Effect|
|---|---|---|
|\`init\`|\`list: [{phase, items: string[]}]\`|Initialize full list; replaces existing|
|\`init\`|\`items: string[]\`|Flattened single-phase init|
|\`start\`|\`task\`|Mark in progress|
|\`done\`|\`task\` or \`phase\`|Mark completed|
|\`drop\`|\`task\` or \`phase\`|Mark abandoned|
|\`block\`|\`task\` or \`phase\`; optional \`reason\`|Mark blocked: open, awaiting external input; excluded from stop-time incomplete-todo reminder|
|\`unblock\`|\`task\` or \`phase\`|Blocked task → \`pending\`|
|\`rm\`|optional \`task\` or \`phase\`|Remove task/phase; omit both → clear|
|\`append\`|\`phase\`; \`items: string[]\`|Append tasks to phase; lazily creates phase|
|\`view\`|—|Read-only; echo list|

## Anatomy

- Task content: 5–10 words; what, not how; unique identifier.
- Phase name: short noun phrase (e.g. \`Foundation\`, \`Auth\`, \`Verification\`); unique identifier. NEVER prefix \`1.\`, \`A)\`, \`Phase 1:\`.

## Rules

- Mark tasks done immediately after finishing; complete phases in order.
- NEVER make a todo call the turn's only tool call. Batch with real work: \`init\` with first reads/edits; each \`done\`/\`start\` with next action. Solo todo turns waste a round trip.
- Waiting on something you can't act on—a user decision, another agent, external service: \`block\` task (optional \`reason\`); remains tracked but avoids stop reminder. \`unblock\` when actionable. If blocker agent-actionable, \`append\` an unblocking task instead.
- Keep introduced \`task\`/\`phase\` strings stable.
- Lost exact task text: \`view\` echoes list; NEVER guess from memory.

## Create a list

- Task requires 3+ distinct steps.
- User explicitly requests one.
- User provides a set of tasks.
- New instructions arrive mid-task: capture before proceeding.

<critical>
User gives multi-step plan—phased todo, numbered/bulleted checklist, or "N bugs/items/tasks":
- MUST \`init\` every item as its own task before working.
- Enumerate all; NEVER summarize into fewer tasks, sample "the important ones", drop items, or track the rest from memory.
</critical>`;
