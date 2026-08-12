/**
 * Persistence: branch replay of todo state.
 * Ported from omp's `getLatestTodoPhasesFromEntries` semantics.
 */

import { describe, expect, it } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	getLatestTodoPhasesFromEntries,
	USER_TODO_EDIT_CUSTOM_TYPE,
} from "../src/persistence.ts";
import type { TodoPhase } from "../src/types.ts";

function messageEntry(
	role: string,
	toolName: string | undefined,
	details: unknown,
	isError = false,
): SessionEntry {
	return {
		id: `m${Math.random()}`,
		parentId: null,
		timestamp: new Date().toISOString(),
		type: "message",
		message: {
			role,
			...(toolName ? { toolName } : {}),
			...(details !== undefined ? { details } : {}),
			...(isError ? { isError: true } : {}),
		},
	} as unknown as SessionEntry;
}

function customEntry(customType: string, data: unknown): SessionEntry {
	return {
		id: `c${Math.random()}`,
		parentId: null,
		timestamp: new Date().toISOString(),
		type: "custom",
		customType,
		data,
	} as unknown as SessionEntry;
}

const phasesA: TodoPhase[] = [
	{ name: "Work", tasks: [{ content: "a", status: "pending" }] },
];
const phasesB: TodoPhase[] = [
	{ name: "Work", tasks: [{ content: "b", status: "completed" }] },
];
const phasesC: TodoPhase[] = [
	{ name: "Cleanup", tasks: [{ content: "c", status: "in_progress" }] },
];

describe("getLatestTodoPhasesFromEntries", () => {
	it("returns [] for an empty branch", () => {
		expect(getLatestTodoPhasesFromEntries([])).toEqual([]);
	});

	it("picks the latest successful todo toolResult details", () => {
		const entries = [
			messageEntry("toolResult", "todo", { phases: phasesA }),
			messageEntry("toolResult", "todo", { phases: phasesB }),
			messageEntry("user", undefined, undefined),
		];
		expect(getLatestTodoPhasesFromEntries(entries)).toEqual(phasesB);
	});

	it("skips error toolResults and unrelated messages", () => {
		const entries = [
			messageEntry("toolResult", "todo", { phases: phasesA }),
			messageEntry("toolResult", "todo", { phases: phasesB }, true),
			messageEntry("toolResult", "bash", { phases: phasesC }),
		];
		expect(getLatestTodoPhasesFromEntries(entries)).toEqual(phasesA);
	});

	it("prefers the newest user_todo_edit custom entry over toolResults", () => {
		const entries = [
			messageEntry("toolResult", "todo", { phases: phasesA }),
			customEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: phasesB }),
		];
		expect(getLatestTodoPhasesFromEntries(entries)).toEqual(phasesB);
	});

	it("falls back to the older toolResult when the custom entry is older", () => {
		const entries = [
			customEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: phasesB }),
			messageEntry("toolResult", "todo", { phases: phasesA }),
		];
		expect(getLatestTodoPhasesFromEntries(entries)).toEqual(phasesA);
	});

	it("ignores malformed custom entries and continues scanning", () => {
		const entries = [
			customEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: "nope" }),
			messageEntry("toolResult", "todo", { phases: phasesC }),
		];
		expect(getLatestTodoPhasesFromEntries(entries)).toEqual(phasesC);
	});

	it("ignores custom entries of other types", () => {
		const entries = [
			customEntry("plan-mode", { phases: phasesC }),
			messageEntry("toolResult", "todo", { phases: phasesA }),
		];
		expect(getLatestTodoPhasesFromEntries(entries)).toEqual(phasesA);
	});

	it("returns a defensive clone (mutating the result does not affect the source)", () => {
		const entries = [messageEntry("toolResult", "todo", { phases: phasesA })];
		const restored = getLatestTodoPhasesFromEntries(entries);
		restored[0]!.tasks[0]!.status = "completed";
		expect(phasesA[0]?.tasks[0]?.status).toBe("pending");
	});
});
