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
import { clonePhases } from "./state.ts";
import type { TodoPhase } from "./types.ts";

export const USER_TODO_EDIT_CUSTOM_TYPE = "user_todo_edit";

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
			if (data && Array.isArray(data.phases)) {
				return clonePhases(data.phases as TodoPhase[]);
			}
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
		if (!details || !Array.isArray(details.phases)) continue;

		return clonePhases(details.phases as TodoPhase[]);
	}

	return [];
}
