import { describe, expect, it } from "bun:test";
import {
	deriveTodoNotifications,
	supportsTodoTerminalNotifications,
} from "../src/notifications.ts";
import type { TodoPhase } from "../src/types.ts";

const phase = (tasks: TodoPhase["tasks"]): TodoPhase => ({
	name: "Work",
	tasks,
});

describe("deriveTodoNotifications", () => {
	it("creates a completion payload for one active task", () => {
		const previous = [phase([{ content: "Ship it", status: "in_progress" }])];
		const next = [phase([{ content: "Ship it", status: "completed" }])];

		expect(deriveTodoNotifications(previous, next)).toEqual([
			{
				title: "Todo",
				body: "Completed 1 todo task",
				type: "todo-completed",
				urgency: "normal",
				sound: "info",
			},
		]);
	});

	it("creates a blocked payload for one active task", () => {
		const previous = [phase([{ content: "Need input", status: "pending" }])];
		const next = [
			phase([{ content: "Need input", status: "blocked", blocker: "waiting" }]),
		];

		expect(deriveTodoNotifications(previous, next)).toEqual([
			{
				title: "Todo",
				body: "Blocked 1 todo task",
				type: "todo-blocked",
				urgency: "normal",
				sound: "warning",
			},
		]);
	});

	it("pluralizes counts and orders completion before blocked", () => {
		const previous: TodoPhase[] = [
			{
				name: "Work",
				tasks: [
					{ content: "a", status: "pending" },
					{ content: "b", status: "in_progress" },
					{ content: "c", status: "pending" },
				],
			},
		];
		const next: TodoPhase[] = [
			{
				name: "Work",
				tasks: [
					{ content: "a", status: "completed" },
					{ content: "b", status: "completed" },
					{ content: "c", status: "blocked" },
				],
			},
		];

		expect(deriveTodoNotifications(previous, next)).toEqual([
			{
				title: "Todo",
				body: "Completed 2 todo tasks",
				type: "todo-completed",
				urgency: "normal",
				sound: "info",
			},
			{
				title: "Todo",
				body: "Blocked 1 todo task",
				type: "todo-blocked",
				urgency: "normal",
				sound: "warning",
			},
		]);
	});

	it("does not notify unchanged terminal tasks or read-only snapshots", () => {
		const snapshot: TodoPhase[] = [
			{
				name: "Work",
				tasks: [
					{ content: "done", status: "completed" },
					{ content: "blocked", status: "blocked", blocker: "waiting" },
				],
			},
		];

		expect(deriveTodoNotifications(snapshot, snapshot)).toEqual([]);
		expect(
			deriveTodoNotifications(snapshot, structuredClone(snapshot)),
		).toEqual([]);
	});

	it("does not notify removed or newly terminal tasks", () => {
		const previous: TodoPhase[] = [
			{
				name: "Work",
				tasks: [
					{ content: "removed", status: "pending" },
					{ content: "abandoned", status: "abandoned" },
				],
			},
		];
		const next: TodoPhase[] = [
			{
				name: "Work",
				tasks: [
					{ content: "new", status: "completed" },
					{ content: "abandoned", status: "blocked" },
				],
			},
		];

		expect(deriveTodoNotifications(previous, next)).toEqual([]);
	});

	it("does not notify transitions from terminal states", () => {
		const previous: TodoPhase[] = [
			{
				name: "Work",
				tasks: [
					{ content: "done", status: "completed" },
					{ content: "blocked", status: "blocked" },
					{ content: "dropped", status: "abandoned" },
				],
			},
		];
		const next: TodoPhase[] = [
			{
				name: "Work",
				tasks: [
					{ content: "done", status: "blocked" },
					{ content: "blocked", status: "completed" },
					{ content: "dropped", status: "completed" },
				],
			},
		];

		expect(deriveTodoNotifications(previous, next)).toEqual([]);
	});

	it("only enables requests for terminals with OSC focus handling", () => {
		expect(supportsTodoTerminalNotifications({ TERM_PROGRAM: "kitty" })).toBe(
			true,
		);
		expect(supportsTodoTerminalNotifications({ TERM_PROGRAM: "ghostty" })).toBe(
			true,
		);
		expect(supportsTodoTerminalNotifications({ TERM_PROGRAM: "wezterm" })).toBe(
			true,
		);
		expect(supportsTodoTerminalNotifications({ TERM_PROGRAM: "xterm" })).toBe(
			false,
		);
	});
});
