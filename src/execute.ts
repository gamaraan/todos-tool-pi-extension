/**
 * The todo tool's execute semantics as a pure function, so the exact omp
 * behavior (batch atomicity, completion transitions, error summaries) can be
 * unit-tested without a live pi session. The extension's `execute` wires this
 * into `ToolDefinition.execute` and throws when `failed` (pi's error signal).
 */

import { formatSummary } from "./format.ts";
import {
	applyParams,
	clonePhases,
	getCompletionTransitions,
	resolveTodoParams,
} from "./state.ts";
import type {
	TodoCompletionTransition,
	TodoOperation,
	TodoParams,
	TodoPhase,
} from "./types.ts";

export interface TodoExecuteOutcome {
	/** Operation that produced this snapshot. */
	op: TodoOperation;
	/** Effective phases after the op (previous on failure or read-only view). */
	phases: TodoPhase[];
	/** Tasks that transitioned to completed in this update. */
	completedTasks: TodoCompletionTransition[];
	/** Text summary for the model. */
	summary: string;
	/** A batch failed wholesale — nothing was applied. */
	failed: boolean;
	/** Whether this was a pure read. */
	readOnly: boolean;
	/** Storage classification: "session" when a session file exists, else "memory". */
	storage: "session" | "memory";
}

/**
 * Apply a single todo op with full omp semantics:
 *
 * 1. `resolveTodoParams` re-validates and repairs a missing `op`.
 * 2. `view` is a pure read: no normalization, no state write.
 * 3. A batch with any error is discarded wholesale: persisting a half-applied
 *    batch makes the natural retry hit "already exists" for the ops that did
 *    land. State and rendered summary stay at previous.
 *
 * @param previous Current phases (defensive clone taken internally).
 * @param rawParams Raw tool call arguments (already schema-validated in pi,
 *                  but re-validated here for the lenient path).
 * @param hasSessionFile True when the session has a file (`"session"` storage).
 */
export function executeTodoOp(
	previous: TodoPhase[],
	rawParams: unknown,
	hasSessionFile: boolean,
): TodoExecuteOutcome {
	const previousPhases = clonePhases(previous);
	const storage = hasSessionFile ? "session" : "memory";
	const resolved = resolveTodoParams(rawParams, previousPhases.length > 0);
	if (typeof resolved === "string") {
		return {
			op: "view",
			phases: previousPhases,
			completedTasks: [],
			summary: resolved,
			failed: true,
			readOnly: false,
			storage,
		};
	}
	const entry: TodoParams = resolved;
	const op = entry.op;
	// Pure-view calls are reads: no normalization, no state write.
	const readOnly = op === "view";
	const { phases: updated, errors } = readOnly
		? { phases: previousPhases, errors: [] as string[] }
		: applyParams(clonePhases(previousPhases), entry);
	const failed = errors.length > 0;
	const effective = failed ? previousPhases : updated;
	const completedTasks =
		readOnly || failed ? [] : getCompletionTransitions(previousPhases, updated);
	return {
		op,
		phases: effective,
		completedTasks,
		summary: formatSummary(effective, errors, readOnly),
		failed,
		readOnly,
		storage,
	};
}
