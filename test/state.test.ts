/**
 * Ported from Oh My Pi's `packages/coding-agent/test/tools/todo.test.ts`
 * (state-semantics subset, adapted to the pi extension's pure functions).
 */

import { describe, expect, it } from "bun:test";
import {
	applyOpsToPhases,
	getCompletionTransitions,
	inferTodoOp,
	isClosedTodo,
	nextActionableTask,
	normalizeInProgressTask,
	selectCollapsedTodos,
	todoMatchesAnyDescription,
} from "../src/state.ts";
import { executeTodoOp } from "../src/execute.ts";
import type { TodoItem, TodoParams, TodoPhase } from "../src/types.ts";

/** Run an op against a growing in-memory state, like the tool's execute. */
function makeTool(initialPhases: TodoPhase[] = []) {
	let phases = initialPhases;
	return {
		run(params: unknown) {
			const outcome = executeTodoOp(phases, params, false);
			if (!outcome.failed && !outcome.readOnly) phases = outcome.phases;
			return outcome;
		},
		get phases() {
			return phases;
		},
	};
}

function summaryText(
	outcome: ReturnType<ReturnType<typeof makeTool>["run"]>,
): string {
	return outcome.summary;
}

describe("executeTodoOp auto-start behavior", () => {
	it("auto-starts the first task after init", () => {
		const tool = makeTool();
		const result = tool.run({
			op: "init",
			list: [{ phase: "Execution", items: ["status", "diagnostics"] }],
		});

		const tasks = result.phases[0]?.tasks ?? [];
		expect(tasks.map((task) => task.status)).toEqual([
			"in_progress",
			"pending",
		]);
		expect(summaryText(result)).toContain("Remaining items (2):");
		expect(summaryText(result)).toContain("status [in_progress] (Execution)");
		expect(summaryText(result)).toContain("diagnostics [pending] (Execution)");
	});

	it("auto-promotes the next pending task when current task is completed", () => {
		const tool = makeTool();
		tool.run({
			op: "init",
			list: [{ phase: "Execution", items: ["status", "diagnostics"] }],
		});

		const result = tool.run({ op: "done", task: "status" });

		const tasks = result.phases[0]?.tasks ?? [];
		expect(tasks.map((task) => task.status)).toEqual([
			"completed",
			"in_progress",
		]);
		expect(result.completedTasks).toEqual([
			{ phase: "Execution", content: "status" },
		]);
		expect(summaryText(result)).toContain("Remaining items (1):");
		expect(summaryText(result)).toContain(
			"diagnostics [in_progress] (Execution)",
		);

		const completedResult = tool.run({ op: "done", task: "diagnostics" });
		expect(summaryText(completedResult)).toContain("Remaining items: none.");
	});
});

describe("nextActionableTask", () => {
	it("returns the in-progress task before the first pending task across phases", () => {
		const task = nextActionableTask([
			{
				name: "First",
				tasks: [{ content: "queued first", status: "pending" }],
			},
			{
				name: "Second",
				tasks: [{ content: "active second", status: "in_progress" }],
			},
		]);

		expect(task?.content).toBe("active second");
	});

	it("falls back to the first pending task when nothing is in progress", () => {
		const task = nextActionableTask([
			{ name: "Done", tasks: [{ content: "finished", status: "completed" }] },
			{
				name: "Next",
				tasks: [{ content: "first pending", status: "pending" }],
			},
		]);

		expect(task?.content).toBe("first pending");
	});
});

describe("TodoTool operations", () => {
	it("jumps to a specific task out of order", () => {
		const tool = makeTool();
		tool.run({
			op: "init",
			list: [{ phase: "Phase A", items: ["first", "second", "third"] }],
		});

		const result = tool.run({ op: "start", task: "third" });

		const tasks = result.phases[0]?.tasks ?? [];
		expect(tasks.map((task) => task.status)).toEqual([
			"pending",
			"pending",
			"in_progress",
		]);
		expect(result.op).toBe("start");
	});

	it("demotes the current in_progress task when starting another", () => {
		const tool = makeTool();
		tool.run({
			op: "init",
			list: [
				{ phase: "A", items: ["a1", "a2"] },
				{ phase: "B", items: ["b1"] },
			],
		});

		const result = tool.run({ op: "start", task: "b1" });

		const allTasks = result.phases.flatMap((phase) => phase.tasks);
		expect(allTasks.map((task) => task.status)).toEqual([
			"pending",
			"pending",
			"in_progress",
		]);
	});

	it("appends items to an existing phase", () => {
		const tool = makeTool();
		tool.run({ op: "init", list: [{ phase: "Work", items: ["First"] }] });

		const result = tool.run({ op: "append", phase: "Work", items: ["Second"] });

		const tasks = result.phases[0]?.tasks ?? [];
		expect(
			tasks.map((task) => ({ content: task.content, status: task.status })),
		).toEqual([
			{ content: "First", status: "in_progress" },
			{ content: "Second", status: "pending" },
		]);
	});

	it("blocks a task (excluded from remaining, counted distinctly) and unblocks it", () => {
		const tool = makeTool();
		tool.run({ op: "init", list: [{ phase: "Work", items: ["a", "b"] }] });

		const blocked = tool.run({
			op: "block",
			task: "b",
			reason: "waiting on sign-off",
		});
		const bTask = blocked.phases[0]?.tasks.find((task) => task.content === "b");
		expect(bTask?.status).toBe("blocked");
		expect(bTask?.blocker).toBe("waiting on sign-off");
		// `a` stays the only open item; `b` leaves the remaining/open set but is surfaced as blocked.
		expect(summaryText(blocked)).toContain("Remaining items (1):");
		expect(summaryText(blocked)).toContain("1 blocked");

		const unblocked = tool.run({ op: "unblock", task: "b" });
		const bAfter = unblocked.phases[0]?.tasks.find(
			(task) => task.content === "b",
		);
		expect(bAfter?.status).toBe("pending");
		expect(bAfter?.blocker).toBeUndefined();
	});

	it("does not auto-promote a blocked task to in_progress", () => {
		const tool = makeTool();
		tool.run({ op: "init", list: [{ phase: "Work", items: ["only"] }] });

		const result = tool.run({ op: "block", task: "only" });

		// `only` was in_progress; blocking it leaves no pending/in_progress, so normalization must not revive it.
		expect(result.phases[0]?.tasks[0]?.status).toBe("blocked");
	});

	it("blocking a phase leaves completed/abandoned tasks closed", () => {
		const tool = makeTool();
		tool.run({ op: "init", list: [{ phase: "Work", items: ["a", "b", "c"] }] });
		tool.run({ op: "done", task: "a" });
		tool.run({ op: "drop", task: "c" });

		const result = tool.run({
			op: "block",
			phase: "Work",
			reason: "waiting on infra",
		});
		const tasks = result.phases[0]?.tasks ?? [];
		const byContent = (content: string) =>
			tasks.find((task) => task.content === content);
		// Completed/abandoned work is untouched; only the open task becomes blocked.
		expect(byContent("a")?.status).toBe("completed");
		expect(byContent("c")?.status).toBe("abandoned");
		expect(byContent("b")?.status).toBe("blocked");
		expect(byContent("b")?.blocker).toBe("waiting on infra");
		// A completed task must never carry a blocker note.
		expect(byContent("a")?.blocker).toBeUndefined();
	});

	it("re-blocking an already-blocked task refines its blocker note", () => {
		const tool = makeTool();
		tool.run({ op: "init", list: [{ phase: "Work", items: ["a", "b"] }] });
		// First block with no reason, then block again to add one — the agent often
		// learns what it's waiting on only after the initial block.
		tool.run({ op: "block", task: "b" });
		const first = tool.run({ op: "block", task: "b" });
		expect(
			first.phases[0]?.tasks.find((task) => task.content === "b")?.blocker,
		).toBeUndefined();

		const refined = tool.run({
			op: "block",
			task: "b",
			reason: "waiting on user",
		});
		const bTask = refined.phases[0]?.tasks.find((task) => task.content === "b");
		expect(bTask?.status).toBe("blocked");
		expect(bTask?.blocker).toBe("waiting on user");
	});

	it("rejects a block with neither task nor phase target", () => {
		const tool = makeTool();
		tool.run({ op: "init", list: [{ phase: "Work", items: ["a", "b"] }] });

		const result = tool.run({ op: "block", reason: "oops" });
		expect(result.failed).toBe(true);
		expect(summaryText(result)).toContain(
			"block requires a task or phase target",
		);
		// Nothing was blocked — state is unchanged.
		const tasks = result.phases[0]?.tasks ?? [];
		expect(tasks.every((task) => task.status !== "blocked")).toBe(true);
	});

	it("rejects an unblock with neither task nor phase target", () => {
		const tool = makeTool();
		tool.run({ op: "init", list: [{ phase: "Work", items: ["a"] }] });
		tool.run({ op: "block", task: "a", reason: "x" });

		const result = tool.run({ op: "unblock" });
		expect(result.failed).toBe(true);
		expect(summaryText(result)).toContain(
			"unblock requires a task or phase target",
		);
		// The blocked task stays blocked — the targetless unblock was rejected.
		expect(result.phases[0]?.tasks[0]?.status).toBe("blocked");
	});

	it("normalizes a multi-line blocker reason so the markdown round-trip survives", () => {
		const tool = makeTool();
		tool.run({ op: "init", list: [{ phase: "Work", items: ["a"] }] });
		// A blocker reason lifted from a multi-line external error or user question.
		const blocked = tool.run({
			op: "block",
			task: "a",
			reason: "waiting on user:\nline two\n\tindented three",
		});
		const stored = blocked.phases[0]?.tasks.find(
			(task) => task.content === "a",
		);
		// Normalized at the source: whitespace runs (incl. newlines) collapse to
		// single spaces, so every one-line consumer stays intact.
		expect(stored?.blocker).toBe("waiting on user: line two indented three");
	});

	it("creates a phase when append targets a missing phase", () => {
		const tool = makeTool();
		tool.run({ op: "init", list: [{ phase: "Work", items: ["First"] }] });

		const result = tool.run({
			op: "append",
			phase: "Cleanup",
			items: ["Remove dead code"],
		});

		expect(result.phases.map((phase) => phase.name)).toEqual([
			"Work",
			"Cleanup",
		]);
		expect(result.phases[1]?.tasks.map((task) => task.content)).toEqual([
			"Remove dead code",
		]);
	});

	it("marks all tasks in a phase done", () => {
		const tool = makeTool();
		tool.run({
			op: "init",
			list: [
				{ phase: "Work", items: ["First", "Second"] },
				{ phase: "Later", items: ["Third"] },
			],
		});

		const result = tool.run({ op: "done", phase: "Work" });
		const allTasks = result.phases.flatMap((phase) => phase.tasks);
		expect(allTasks.map((task) => task.status)).toEqual([
			"completed",
			"completed",
			"in_progress",
		]);
	});

	it("removes all tasks when rm omits task and phase", () => {
		const tool = makeTool();
		tool.run({
			op: "init",
			list: [{ phase: "Work", items: ["First", "Second"] }],
		});

		const result = tool.run({ op: "rm" });
		expect(result.phases[0]?.tasks).toEqual([]);
		expect(summaryText(result)).toContain("Todo list cleared.");
	});

	it("drops all tasks in a phase", () => {
		const tool = makeTool();
		tool.run({
			op: "init",
			list: [{ phase: "Work", items: ["First", "Second"] }],
		});

		const result = tool.run({ op: "drop", phase: "Work" });
		const tasks = result.phases[0]?.tasks ?? [];
		expect(tasks.map((task) => task.status)).toEqual([
			"abandoned",
			"abandoned",
		]);
	});

	it("view echoes state without mutating it", () => {
		const initial: TodoPhase[] = [
			{
				name: "Work",
				tasks: [
					{ content: "First", status: "pending" },
					{ content: "Second", status: "pending" },
				],
			},
		];
		const tool = makeTool(initial);

		const result = tool.run({ op: "view" });

		const tasks = result.phases[0]?.tasks ?? [];
		expect(tasks.map((task) => task.status)).toEqual(["pending", "pending"]);
		// A read never normalizes or writes state back.
		expect(tool.phases[0]?.tasks.map((task) => task.status)).toEqual([
			"pending",
			"pending",
		]);
		expect(summaryText(result)).toContain("First");
		expect(summaryText(result)).toContain("Second");
	});

	it("view on an empty list reports empty, not cleared", () => {
		const tool = makeTool();
		const result = tool.run({ op: "view" });
		expect(summaryText(result)).toContain("Todo list is empty.");
		expect(result.failed).toBe(false);
	});
});

describe("lenient init shapes", () => {
	it("accepts a flattened init with bare items and no phase", () => {
		const tool = makeTool();
		const result = tool.run({ op: "init", items: ["First", "Second"] });

		expect(result.failed).toBe(false);
		expect(result.phases.map((phase) => phase.name)).toEqual(["Tasks"]);
		const tasks = result.phases[0]?.tasks ?? [];
		expect(
			tasks.map((task) => ({ content: task.content, status: task.status })),
		).toEqual([
			{ content: "First", status: "in_progress" },
			{ content: "Second", status: "pending" },
		]);
	});

	it("honors a bare phase on a flattened init", () => {
		const tool = makeTool();
		const result = tool.run({
			op: "init",
			phase: "Cleanup",
			items: ["Remove dead code"],
		});

		expect(result.failed).toBe(false);
		expect(result.phases.map((phase) => phase.name)).toEqual(["Cleanup"]);
		expect(result.phases[0]?.tasks.map((task) => task.content)).toEqual([
			"Remove dead code",
		]);
	});

	it("still errors when init has neither list nor items", () => {
		const tool = makeTool();
		const result = tool.run({ op: "init" });

		expect(result.failed).toBe(true);
		expect(summaryText(result)).toContain("Missing list for init operation");
	});
});

describe("lenient op recovery", () => {
	it("infers init from a bare list payload", () => {
		const tool = makeTool();
		expect(
			inferTodoOp({ list: [{ phase: "Fixes", items: ["One"] }] }, false),
		).toBe("init");
		const result = tool.run({
			list: [
				{
					phase: "Fixes",
					items: ["Bytecompiler ordering", "Posix path fd handling"],
				},
			],
		});

		expect(result.failed).toBe(false);
		expect(result.op).toBe("init");
		expect(result.phases.map((phase) => phase.name)).toEqual(["Fixes"]);
		expect(result.phases[0]?.tasks.map((task) => task.content)).toEqual([
			"Bytecompiler ordering",
			"Posix path fd handling",
		]);
	});

	it("infers append from phase plus items", () => {
		const tool = makeTool();
		tool.run({ op: "init", list: [{ phase: "Work", items: ["First"] }] });

		const result = tool.run({ phase: "Work", items: ["Second"] });

		expect(result.failed).toBe(false);
		expect(result.op).toBe("append");
		expect(result.phases[0]?.tasks.map((task) => task.content)).toEqual([
			"First",
			"Second",
		]);
	});

	it("infers init from bare items only when no todos exist", () => {
		const fresh = makeTool();
		const initialized = fresh.run({ items: ["Only task"] });
		expect(initialized.failed).toBe(false);
		expect(initialized.op).toBe("init");

		// With existing todos the same shape is ambiguous (flat init would wipe
		// the list; append lacks a phase) and must error instead of guessing.
		const populated = makeTool([
			{ name: "Work", tasks: [{ content: "First", status: "pending" }] },
		]);
		const ambiguous = populated.run({ items: ["Second"] });
		expect(ambiguous.failed).toBe(true);
	});

	it("surfaces the schema error when op is missing and not inferable", () => {
		const tool = makeTool();
		const result = tool.run({ task: "Something" });

		expect(result.failed).toBe(true);
		expect(summaryText(result)).toContain("Invalid todo arguments");
	});
});

describe("empty items tolerance", () => {
	it("accepts op:view with an empty items array", () => {
		const tool = makeTool();
		const result = tool.run({ op: "view", items: [] });
		expect(result.failed).toBe(false);
		expect(summaryText(result)).toContain("Todo list is empty.");
	});

	it("defers empty append items to an op-specific runtime error", () => {
		const tool = makeTool();
		tool.run({ op: "init", list: [{ phase: "Work", items: ["First"] }] });

		const result = tool.run({ op: "append", phase: "Work", items: [] });

		expect(result.failed).toBe(true);
		expect(summaryText(result)).toContain("Missing items for append operation");
	});
});

describe("todoMatchesAnyDescription", () => {
	it("matches identical strings", () => {
		expect(
			todoMatchesAnyDescription("Sonnet #1: AGENTS audit", [
				"Sonnet #1: AGENTS audit",
			]),
		).toBe(true);
	});

	it("matches case- and whitespace-insensitively", () => {
		expect(
			todoMatchesAnyDescription("  Sonnet  #1: AGENTS Audit  ", [
				"sonnet #1: agents audit",
			]),
		).toBe(true);
	});

	it("matches when description is a long-enough substring of the todo", () => {
		expect(
			todoMatchesAnyDescription("Sonnet #2: shallow bug scan of diff", [
				"Sonnet #2",
			]),
		).toBe(true);
	});

	it("matches when the todo is a long-enough substring of a description", () => {
		expect(
			todoMatchesAnyDescription("Sonnet #3", [
				"Sonnet #3: git blame / history check",
			]),
		).toBe(true);
	});

	it("rejects substring matches below the minimum overlap", () => {
		// "Fix" is 3 chars — too short to qualify on either side.
		expect(todoMatchesAnyDescription("Fix", ["Fix the auth module bug"])).toBe(
			false,
		);
		expect(todoMatchesAnyDescription("Fix the auth module bug", ["Fix"])).toBe(
			false,
		);
	});

	it("ignores empty inputs without throwing", () => {
		expect(todoMatchesAnyDescription("", ["Sonnet #1"])).toBe(false);
		expect(todoMatchesAnyDescription("Sonnet #1", [""])).toBe(false);
		expect(todoMatchesAnyDescription("Sonnet #1", [])).toBe(false);
	});

	it("ignores punctuation differences in identifiers", () => {
		expect(
			todoMatchesAnyDescription("Audit integration site in renderTodoList", [
				"Audit integration site in #renderTodoList",
			]),
		).toBe(true);
		expect(
			todoMatchesAnyDescription("Audit AGENTS.md compliance", [
				"Audit AGENTS md compliance",
			]),
		).toBe(true);
	});
});

describe("isClosedTodo", () => {
	it("treats completed and abandoned as closed, everything else open", () => {
		expect(isClosedTodo({ content: "a", status: "completed" })).toBe(true);
		expect(isClosedTodo({ content: "a", status: "abandoned" })).toBe(true);
		expect(isClosedTodo({ content: "a", status: "pending" })).toBe(false);
		expect(isClosedTodo({ content: "a", status: "in_progress" })).toBe(false);
		expect(isClosedTodo({ content: "a", status: "blocked" })).toBe(false);
	});
});

describe("selectCollapsedTodos walking viewport", () => {
	const mk = (n: number, inProgress: number[]): TodoItem[] =>
		Array.from({ length: n }, (_, i) => ({
			content: `Task ${i + 1}`,
			status: inProgress.includes(i + 1) ? "in_progress" : "pending",
		}));
	const never = () => false;
	const contents = (sel: { items: TodoItem[] }) =>
		sel.items.map((t) => t.content);

	it("starts at the sole in-progress task and fills with following tasks", () => {
		const sel = selectCollapsedTodos(mk(14, [6]), never, 8);
		expect(contents(sel)).toEqual([
			"Task 6",
			"Task 7",
			"Task 8",
			"Task 9",
			"Task 10",
			"Task 11",
			"Task 12",
			"Task 13",
		]);
		expect(sel.summary).toContain("6 more todos");
	});

	it("leads with the last closed task and omits the rest in collapsed mode", () => {
		const tasks: TodoItem[] = [
			{ content: "done", status: "completed" },
			{ content: "dropped", status: "abandoned" },
			{ content: "current", status: "in_progress" },
			{ content: "next", status: "pending" },
		];
		const sel = selectCollapsedTodos(tasks, never, 5);
		// One closed row survives so a completion is visible as it lands; earlier
		// closed work stays hidden.
		expect(contents(sel)).toEqual(["dropped", "current", "next"]);
		expect(sel.summary).toBe("");
	});

	it("keeps an out-of-order completion as the closed lead row", () => {
		const tasks: TodoItem[] = [
			{ content: "current", status: "in_progress" },
			{ content: "next", status: "pending" },
			{ content: "finished early", status: "completed" },
		];
		const sel = selectCollapsedTodos(tasks, never, 5);
		expect(contents(sel)).toEqual(["finished early", "current", "next"]);
	});

	it("keeps the closed lead row additive to the open-task cap", () => {
		const tasks: TodoItem[] = [
			{ content: "closed", status: "completed" },
			...mk(5, [1]),
		];
		const sel = selectCollapsedTodos(tasks, never, 5);
		// All 5 open tasks fit the cap; the closed context row does not evict one.
		expect(contents(sel)).toEqual([
			"closed",
			"Task 1",
			"Task 2",
			"Task 3",
			"Task 4",
			"Task 5",
		]);
		expect(sel.summary).toBe("");
	});

	it("places every matched todo at the head in todo order", () => {
		const tasks = mk(14, []);
		const matched = (t: TodoItem) =>
			t.content === "Task 3" || t.content === "Task 9";
		const sel = selectCollapsedTodos(tasks, matched, 5);
		expect(contents(sel).slice(0, 2)).toEqual(["Task 3", "Task 9"]);
		expect(contents(sel)).toHaveLength(5);
	});

	it("caps active todos and counts the hidden actives in the summary", () => {
		const tasks = mk(10, []);
		const matched = (t: TodoItem) =>
			[
				"Task 1",
				"Task 2",
				"Task 3",
				"Task 4",
				"Task 5",
				"Task 6",
				"Task 7",
			].includes(t.content);
		const sel = selectCollapsedTodos(tasks, matched, 5);
		expect(contents(sel)).toEqual([
			"Task 1",
			"Task 2",
			"Task 3",
			"Task 4",
			"Task 5",
		]);
		expect(sel.summary).toBe("… 2 more active todos");
		expect(
			contents(sel).some((c) => ["Task 8", "Task 9", "Task 10"].includes(c)),
		).toBe(false);
	});

	it("keeps a summary when actives exactly fill the cap but pending remains", () => {
		const tasks = mk(6, []);
		const matched = (t: TodoItem) =>
			["Task 1", "Task 2", "Task 3", "Task 4", "Task 5"].includes(t.content);
		const sel = selectCollapsedTodos(tasks, matched, 5);
		expect(contents(sel)).toEqual([
			"Task 1",
			"Task 2",
			"Task 3",
			"Task 4",
			"Task 5",
		]);
		expect(sel.summary).toBe("… 1 more todo");
	});

	it("returns the whole open set with no summary when it fits", () => {
		const sel = selectCollapsedTodos(mk(3, [2]), never, 5);
		expect(contents(sel)).toEqual(["Task 1", "Task 2", "Task 3"]);
		expect(sel.summary).toBe("");
	});

	it("falls back to closed tasks when the phase has no open work", () => {
		const tasks: TodoItem[] = [
			{ content: "done a", status: "completed" },
			{ content: "done b", status: "completed" },
		];
		const sel = selectCollapsedTodos(tasks, never, 5);
		expect(contents(sel)).toEqual(["done a", "done b"]);
	});
});

describe("getCompletionTransitions", () => {
	it("reports only tasks that transitioned to completed in this update", () => {
		const previous: TodoPhase[] = [
			{
				name: "Work",
				tasks: [
					{ content: "a", status: "pending" },
					{ content: "b", status: "completed" },
				],
			},
		];
		const updated: TodoPhase[] = [
			{
				name: "Work",
				tasks: [
					{ content: "a", status: "completed" },
					{ content: "b", status: "completed" },
				],
			},
		];
		expect(getCompletionTransitions(previous, updated)).toEqual([
			{ phase: "Work", content: "a" },
		]);
	});
});

describe("applyOpsToPhases", () => {
	it("applies a batch of ops with normalization at the end", () => {
		const current: TodoPhase[] = [
			{ name: "Work", tasks: [{ content: "a", status: "pending" }] },
		];
		const ops: TodoParams[] = [
			{ op: "append", phase: "Work", items: ["b"] },
			{ op: "done", task: "a" },
		];
		const { phases, errors } = applyOpsToPhases(current, ops);
		expect(errors).toEqual([]);
		// a completed, b auto-promoted to in_progress
		expect(phases[0]?.tasks.map((task) => task.status)).toEqual([
			"completed",
			"in_progress",
		]);
	});
});

describe("normalizeInProgressTask", () => {
	it("keeps only the first in-progress task across phases", () => {
		const phases: TodoPhase[] = [
			{
				name: "A",
				tasks: [
					{ content: "a1", status: "in_progress" },
					{ content: "a2", status: "in_progress" },
				],
			},
			{ name: "B", tasks: [{ content: "b1", status: "in_progress" }] },
		];
		normalizeInProgressTask(phases);
		expect(phases.flatMap((p) => p.tasks).map((t) => t.status)).toEqual([
			"in_progress",
			"pending",
			"pending",
		]);
	});

	it("promotes the first pending task when nothing is in progress", () => {
		const phases: TodoPhase[] = [
			{
				name: "A",
				tasks: [
					{ content: "a1", status: "pending" },
					{ content: "a2", status: "pending" },
				],
			},
		];
		normalizeInProgressTask(phases);
		expect(phases[0]?.tasks.map((t) => t.status)).toEqual([
			"in_progress",
			"pending",
		]);
	});
});

describe("single-line normalization of task content and phase names", () => {
	it("collapses newlines and tabs in init items and phase names", () => {
		const tool = makeTool();
		const result = tool.run({
			op: "init",
			list: [
				{
					phase: "  Recon\nphase  ",
					items: ["line1\nline2", "tabbed\ttask", "  padded  "],
				},
			],
		});

		expect(result.failed).toBe(false);
		expect(result.phases.map((phase) => phase.name)).toEqual(["Recon phase"]);
		expect(result.phases[0]?.tasks.map((task) => task.content)).toEqual([
			"line1 line2",
			"tabbed task",
			"padded",
		]);
	});

	it("rejects whitespace-only items and phase names in init", () => {
		const tool = makeTool();
		const blankItem = tool.run({ op: "init", items: ["ok", "  \n "] });
		expect(blankItem.failed).toBe(true);
		expect(summaryText(blankItem)).toContain("Empty task content");

		const blankPhase = tool.run({
			op: "init",
			list: [{ phase: " \t ", items: ["ok"] }],
		});
		expect(blankPhase.failed).toBe(true);
		expect(summaryText(blankPhase)).toContain("Empty phase name");
	});

	it("detects duplicates after normalization", () => {
		const tool = makeTool();
		const result = tool.run({ op: "init", items: ["a  b", "a\nb"] });
		expect(result.failed).toBe(true);
		expect(summaryText(result)).toContain('Duplicate task "a b"');
	});

	it("normalizes append phase names and items", () => {
		const tool = makeTool();
		const init = tool.run({ op: "init", items: ["one"] });
		expect(init.failed).toBe(false);
		const result = tool.run({
			op: "append",
			phase: "later\nphase",
			items: ["two\nlines"],
		});

		expect(result.failed).toBe(false);
		expect(
			result.phases.map((phase) => [
				phase.name,
				phase.tasks.map((task) => task.content),
			]),
		).toEqual([
			["Tasks", ["one"]],
			["later phase", ["two lines"]],
		]);
	});

	it("rejects whitespace-only phase and items on append", () => {
		const tool = makeTool([{ name: "A", tasks: [] }]);
		const blankPhase = tool.run({ op: "append", phase: "  ", items: ["x"] });
		expect(blankPhase.failed).toBe(true);
		expect(summaryText(blankPhase)).toContain(
			"Missing phase name for append operation",
		);

		const blankItem = tool.run({ op: "append", phase: "A", items: ["\t"] });
		expect(blankItem.failed).toBe(true);
		expect(summaryText(blankItem)).toContain("Empty task content");
	});
});
