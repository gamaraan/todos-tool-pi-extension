/**
 * Todo state persistence: reconstruct the latest todo phases by scanning a
 * session branch backward, exactly like omp's `getLatestTodoPhasesFromEntries`.
 *
 * Two durable sources, newest-first, first match wins:
 * 1. an explicit custom entry `user_todo_edit` (`{ phases }`) — written by
 *    every `/todo` manual edit;
 * 2. the latest successful `todo` toolResult message's `details.phases` —
 *    the tool result itself is the durable record.
 */

import type {
	CustomEntry,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { clonePhases, isTodoPhase } from "./state.ts";
import type { TodoPhase } from "./types.ts";

export const USER_TODO_EDIT_CUSTOM_TYPE = "user_todo_edit";

/**
 * Accept a persisted phases array only when every entry structurally
 * validates. Session files are plain on-disk JSON: a hand edit, a truncated
 * write, or a stale entry from another tool version would otherwise crash
 * the replay (e.g. `phase.tasks` not an array) on every session start.
 * Invalid snapshots are skipped so the scan falls through to the previous
 * durable record.
 */
function validPersistedPhases(value: unknown): TodoPhase[] | undefined {
	if (!Array.isArray(value)) return undefined;
	if (!value.every(isTodoPhase)) return undefined;
	return clonePhases(value);
}

/** Scan a session branch (oldest-first as returned by `getBranch()`) for the
 *  latest todo snapshot, scanning from the end backward. */
export function getLatestTodoPhasesFromEntries(
	entries: SessionEntry[],
): TodoPhase[] {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry === undefined) continue;
		if (
			entry.type === "custom" &&
			entry.customType === USER_TODO_EDIT_CUSTOM_TYPE
		) {
			const customEntry = entry as CustomEntry<
				{ phases?: unknown } | undefined
			>;
			const data = customEntry.data;
			const restored = data ? validPersistedPhases(data.phases) : undefined;
			if (restored) return restored;
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message as {
			role?: string;
			toolName?: string;
			details?: unknown;
			isError?: boolean;
		};
		if (
			message.role !== "toolResult" ||
			message.toolName !== "todo" ||
			message.isError
		)
			continue;

		const details = message.details as { phases?: unknown } | undefined;
		if (!details) continue;
		const restored = validPersistedPhases(details.phases);
		if (restored) return restored;
	}

	return [];
}
