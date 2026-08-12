/**
 * TUI renderer behavior, ported/adapted from omp's `todoToolRenderer` tests.
 *
 * Adaptations: pi has no spinner frame in render options, so completed tasks
 * strike through immediately (no reveal animation); the renderer returns a
 * plain multi-line Text component.
 */

import { describe, expect, it } from "bun:test";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { executeTodoOp } from "../src/execute.ts";
import {
	formatPhaseDisplayName,
	phaseRomanNumeral,
	sanitizeText,
	strikeRevealCount,
	TODO_STRIKE_HOLD_FRAMES,
	TODO_STRIKE_TOTAL_FRAMES,
	todoRenderCall,
	todoRenderResult,
} from "../src/render.ts";
import type { TodoPhase, TodoToolDetails } from "../src/types.ts";
import { makeTestTheme } from "./helpers.ts";

const theme = makeTestTheme();

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function renderComponent(component: Component): string {
	return stripAnsi(component.render(120).join("\n"));
}

function makeResult(
	details: TodoToolDetails,
	content = "ok",
): AgentToolResult<TodoToolDetails> {
	return {
		content: [{ type: "text", text: content }],
		details,
	};
}

describe("phaseRomanNumeral / formatPhaseDisplayName", () => {
	it("renders one-based roman numerals", () => {
		expect(phaseRomanNumeral(1)).toBe("I");
		expect(phaseRomanNumeral(2)).toBe("II");
		expect(phaseRomanNumeral(4)).toBe("IV");
		expect(phaseRomanNumeral(9)).toBe("IX");
		expect(phaseRomanNumeral(12)).toBe("XII");
		expect(phaseRomanNumeral(0)).toBe("");
	});

	it("formats the display name with the numeral prefix", () => {
		expect(formatPhaseDisplayName("Foundation", 1)).toBe("I. Foundation");
		expect(formatPhaseDisplayName("Auth", 2)).toBe("II. Auth");
	});
});

describe("sanitizeText", () => {
	it("strips ANSI/C0 controls but preserves readable text", () => {
		const hostile = "clear\u001b[2Jscreen\u0007bell";
		const cleaned = sanitizeText(hostile);
		expect(cleaned).not.toContain("\u001b[2J");
		expect(cleaned).not.toContain("\u0007");
		expect(cleaned).toContain("clear");
		expect(cleaned).toContain("screen");
	});

	it("preserves tabs (consumers replace them separately)", () => {
		expect(sanitizeText("a\tb")).toBe("a\tb");
	});
});

describe("strikeRevealCount", () => {
	it("holds before the reveal window and completes after it", () => {
		expect(strikeRevealCount("finish", 0)).toBe(0);
		expect(strikeRevealCount("finish", TODO_STRIKE_HOLD_FRAMES)).toBe(0);
		expect(
			strikeRevealCount("finish", TODO_STRIKE_HOLD_FRAMES + 1),
		).toBeGreaterThan(0);
		expect(strikeRevealCount("finish", TODO_STRIKE_TOTAL_FRAMES)).toBe(6);
		expect(strikeRevealCount("finish", undefined)).toBeUndefined();
	});
});

describe("todoRenderResult", () => {
	function afterDone(): AgentToolResult<TodoToolDetails> {
		const first = executeTodoOp(
			[],
			{ op: "init", list: [{ phase: "Execution", items: ["finish"] }] },
			true,
		);
		const second = executeTodoOp(
			first.phases,
			{ op: "done", task: "finish" },
			true,
		);
		return makeResult({
			op: second.op,
			phases: second.phases,
			storage: "session",
			completedTasks: second.completedTasks,
		});
	}

	it("renders completed tasks with strikethrough immediately", () => {
		const rendered = todoRenderResult(
			afterDone(),
			{ expanded: true, isPartial: false },
			theme,
		);
		const withAnsi = rendered.render(120).join("\n");
		expect(withAnsi).toContain("\x1b[9m"); // strike start
		expect(stripAnsi(withAnsi)).toContain("finish");
	});

	it("renders an error result with the error text", () => {
		const component = todoRenderResult(
			{
				content: [{ type: "text", text: 'Task "nope" not found' }],
				details: { phases: [], storage: "session" },
			},
			{ expanded: true, isPartial: false },
			theme,
			undefined,
			true,
		);
		const rendered = renderComponent(component);
		expect(rendered).toContain('Task "nope" not found');
	});

	it("collapses untouched phases while expanding the active phase", () => {
		const first = executeTodoOp(
			[],
			{
				op: "init",
				list: [
					{ phase: "Alpha", items: ["a1", "a2"] },
					{ phase: "Beta", items: ["b1", "b2"] },
					{ phase: "Gamma", items: ["c1", "c2"] },
				],
			},
			true,
		);
		const second = executeTodoOp(
			first.phases,
			{ op: "done", task: "a1" },
			true,
		);
		const result = makeResult({
			op: "done",
			phases: second.phases,
			storage: "session",
			completedTasks: second.completedTasks,
		});
		const component = todoRenderResult(
			result,
			{ expanded: false, isPartial: false },
			theme,
			{
				op: "done",
				task: "a1",
			},
		);
		const rendered = renderComponent(component);
		// Active phase's collapsed viewport keeps the just-closed task as the lead
		// row and shows the promoted current one, and its header carries progress.
		expect(rendered).toContain("a1");
		expect(rendered).toContain("a2");
		expect(rendered).toContain("I. Alpha");
		expect(rendered).toContain("1/2");
		// Untouched phases collapse: headers + progress counts, no task contents.
		expect(rendered).toContain("II. Beta");
		expect(rendered).toContain("III. Gamma");
		expect(rendered).toContain("0/2");
		expect(rendered).not.toContain("b1");
		expect(rendered).not.toContain("b2");
		expect(rendered).not.toContain("c1");
		expect(rendered).not.toContain("c2");
	});

	it("shows every phase fully when manually expanded", () => {
		const first = executeTodoOp(
			[],
			{
				op: "init",
				list: [
					{ phase: "Alpha", items: ["a1", "a2"] },
					{ phase: "Beta", items: ["b1", "b2"] },
					{ phase: "Gamma", items: ["c1", "c2"] },
				],
			},
			true,
		);
		const second = executeTodoOp(
			first.phases,
			{ op: "done", task: "a1" },
			true,
		);
		const result = makeResult({
			op: "done",
			phases: second.phases,
			storage: "session",
		});
		const component = todoRenderResult(
			result,
			{ expanded: true, isPartial: false },
			theme,
			{
				op: "done",
				task: "a1",
			},
		);
		const rendered = renderComponent(component);
		expect(rendered).toContain("b1");
		expect(rendered).toContain("b2");
		expect(rendered).toContain("c1");
		expect(rendered).toContain("c2");
	});

	it("renders statuses with their markers and notes", () => {
		const phases: TodoPhase[] = [
			{
				name: "Work",
				tasks: [
					{ content: "pending task", status: "pending" },
					{ content: "active task", status: "in_progress" },
					{
						content: "blocked task",
						status: "blocked",
						blocker: "waiting on user",
					},
					{ content: "dropped task", status: "abandoned" },
				],
			},
		];
		const component = todoRenderResult(
			makeResult({ op: "view", phases, storage: "session" }),
			{ expanded: true, isPartial: false },
			theme,
		);
		const rendered = renderComponent(component);
		expect(rendered).toContain("pending task");
		expect(rendered).toContain("active task");
		expect(rendered).toContain("blocked task (blocked: waiting on user)");
		expect(rendered).toContain("dropped task");
	});

	it("renders the empty-list fallback text", () => {
		const component = todoRenderResult(
			makeResult(
				{ op: "view", phases: [], storage: "session" },
				"Todo list is empty.",
			),
			{ expanded: true, isPartial: false },
			theme,
		);
		const rendered = renderComponent(component);
		expect(rendered).toContain("Todo list is empty.");
	});

	it("strips control sequences from task labels and phase names", () => {
		const hostile: TodoPhase[] = [
			{
				name: "Set\u001b[2Jup",
				tasks: [{ content: "ship\u001b[2Jit", status: "pending" }],
			},
			{ name: "Ship", tasks: [{ content: "b", status: "pending" }] },
		];
		const component = todoRenderResult(
			makeResult({ op: "view", phases: hostile, storage: "session" }),
			{ expanded: true, isPartial: false },
			theme,
		);
		const withAnsi = component.render(120).join("\n");
		expect(withAnsi).not.toContain("\u001b[2J");
		expect(stripAnsi(withAnsi)).toContain("I. Setup");
		expect(stripAnsi(withAnsi)).toContain("ship");
		expect(stripAnsi(withAnsi)).toContain("it");
	});
});

describe("todoRenderCall", () => {
	it("renders op summary metadata for a well-formed call", () => {
		const component = todoRenderCall(
			{ op: "init", items: ["a", "b", "c"] },
			theme,
		);
		const rendered = renderComponent(component);
		expect(rendered).toContain("init");
		expect(rendered).toContain("3 items");
	});

	it("does not throw on streaming-truncated args", () => {
		expect(() =>
			todoRenderCall(
				{ op: 1 } as unknown as Parameters<typeof todoRenderCall>[0],
				theme,
			),
		).not.toThrow();
		expect(() =>
			todoRenderCall(
				{ ops: '[{"op":"init"' } as unknown as Parameters<
					typeof todoRenderCall
				>[0],
				theme,
			),
		).not.toThrow();
		expect(() =>
			todoRenderCall(
				{ op: "append", items: "x" as unknown as string[] },
				theme,
			),
		).not.toThrow();
	});

	it("renders legacy multi-op ops arrays", () => {
		const component = todoRenderCall(
			{
				ops: [
					{ op: "init", items: ["a", "b", "c"] },
					{ op: "done", task: "a" },
					{ op: "append", phase: "Cleanup", items: ["d"] },
				],
			},
			theme,
		);
		const rendered = renderComponent(component);
		expect(rendered).toContain("init");
		expect(rendered).toContain("3 items");
		expect(rendered).toContain("done");
		expect(rendered).toContain("append");
		expect(rendered).toContain("Cleanup");
		expect(rendered).toContain("1 item");
	});

	it("strips control sequences and tabs from fragments", () => {
		const component = todoRenderCall(
			{ op: "done", task: "ship\u001b[2Jit\tnow", phase: "Exec\u0007ution" },
			theme,
		);
		const withAnsi = component.render(120).join("\n");
		expect(withAnsi).not.toContain("\u001b[2J");
		expect(withAnsi).not.toContain("\u0007");
		expect(withAnsi).not.toContain("\t");
		const rendered = stripAnsi(withAnsi);
		expect(rendered).toContain("ship");
		expect(rendered).toContain("it");
		expect(rendered).toContain("Exec");
	});
});
