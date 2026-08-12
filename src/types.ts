/**
 * Todo types and the TypeBox schema for the `todo` tool.
 *
 * Ported from Oh My Pi's `packages/coding-agent/src/tools/todo.ts` (omptype
 * schema swapped for TypeBox, which is what pi's tool definitions use).
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

export type TodoStatus =
	| "pending"
	| "in_progress"
	| "completed"
	| "abandoned"
	| "blocked";
/** Operation names accepted by the todo tool and echoed in successful result details. */
export type TodoOperation =
	| "init"
	| "start"
	| "done"
	| "rm"
	| "drop"
	| "block"
	| "unblock"
	| "append"
	| "view";

export interface TodoItem {
	content: string;
	status: TodoStatus;
	/** When `status === "blocked"`, an optional note on what the task is waiting for. */
	blocker?: string;
}

export interface TodoPhase {
	name: string;
	tasks: TodoItem[];
}

export interface TodoCompletionTransition {
	phase: string;
	content: string;
}

export interface TodoToolDetails {
	/** Operation that produced this snapshot; absent on legacy transcript entries. */
	op?: TodoOperation;
	phases: TodoPhase[];
	storage: "session" | "memory";
	completedTasks?: TodoCompletionTransition[];
}

// =============================================================================
// Schema
// =============================================================================

const TodoOp = StringEnum(
	[
		"init",
		"start",
		"done",
		"rm",
		"drop",
		"block",
		"unblock",
		"append",
		"view",
	] as const,
	{ description: "operation to apply" },
);

const InitListEntry = Type.Object({
	phase: Type.String({ description: "phase name" }),
	items: Type.Array(Type.String({ description: "task content" }), {
		minItems: 1,
		description: "tasks for this phase",
	}),
});

export const todoSchema = Type.Object(
	{
		op: TodoOp,
		list: Type.Optional(
			Type.Array(InitListEntry, { description: "phased task list (init)" }),
		),
		task: Type.Optional(Type.String({ description: "task content" })),
		phase: Type.Optional(Type.String({ description: "phase name" })),
		// No `minItems` here: `items` is only meaningful for `init`/`append`,
		// and both enforce non-empty with op-specific errors. A stray `items: []` on
		// an op that ignores it (e.g. `view`) must not be a hard schema rejection.
		items: Type.Optional(
			Type.Array(Type.String({ description: "task content" }), {
				description: "tasks to append",
			}),
		),
		reason: Type.Optional(
			Type.String({ description: "blocker note (block op)" }),
		),
	},
	{ description: "apply a single todo operation" },
);

export type TodoParams = Static<typeof todoSchema>;
