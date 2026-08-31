/**
 * Ported from Oh My Pi's `packages/coding-agent/test/tools/todo.test.ts`
 * (markdown round-trip + path resolution subset).
 */

import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	markdownToPhases,
	phasesToMarkdown,
	resolveTodoMarkdownPath,
} from "../src/markdown.ts";
import type { TodoPhase } from "../src/types.ts";

describe("resolveTodoMarkdownPath", () => {
	it("defaults to TODO.md under cwd", () => {
		const cwd = path.resolve("tmp", "todo-workspace");
		expect(resolveTodoMarkdownPath("", cwd)).toBe(path.join(cwd, "TODO.md"));
	});

	it("strips surrounding double quotes before resolving", () => {
		const cwd = path.resolve("tmp", "todo-workspace");
		expect(resolveTodoMarkdownPath('"my todos.md"', cwd)).toBe(
			path.join(cwd, "my todos.md"),
		);
	});

	it("rejects internal URL schemes", () => {
		const cwd = path.resolve("tmp", "todo-workspace");
		expect(() => resolveTodoMarkdownPath("artifact://todo", cwd)).toThrow(
			"internal scheme",
		);
	});

	it("resolves absolute paths as-is", () => {
		const cwd = path.resolve("tmp", "todo-workspace");
		const target = path.join(cwd, "nested", "list.md");
		expect(resolveTodoMarkdownPath(target, cwd)).toBe(target);
	});

	it("expands a leading tilde", () => {
		const cwd = path.resolve("tmp", "todo-workspace");
		const resolved = resolveTodoMarkdownPath("~/todos.md", cwd);
		expect(resolved.endsWith(path.join("todos.md"))).toBe(true);
		expect(resolved.startsWith(cwd)).toBe(false);
	});
});

describe("phasesToMarkdown / markdownToPhases round-trip", () => {
	it("renders an empty list as a bare # Todos header", () => {
		expect(phasesToMarkdown([])).toBe("# Todos\n");
	});

	it("round-trips multi-phase lists with all statuses", () => {
		const phases: TodoPhase[] = [
			{
				name: "Foundation",
				tasks: [
					{ content: "Scaffold crate", status: "in_progress" },
					{ content: "Wire workspace", status: "completed" },
					{ content: "Drop plan", status: "abandoned" },
				],
			},
			{
				name: "Auth",
				tasks: [{ content: "Port credential store", status: "pending" }],
			},
		];

		const md = phasesToMarkdown(phases);
		expect(md).toBe(
			"# Foundation\n- [/] Scaffold crate\n- [x] Wire workspace\n- [-] Drop plan\n\n# Auth\n- [ ] Port credential store\n",
		);

		const { phases: parsed, errors } = markdownToPhases(md);
		expect(errors).toEqual([]);
		expect(parsed).toEqual(phases);
	});

	it("round-trips blocked tasks containing comment-like sequences", () => {
		// Regression: the blocker-comment parser must bind to the TRAILING
		// comment the writer emits, even when content/blocker themselves
		// contain `-->` or a literal `<!-- blocker:`.
		const phases: TodoPhase[] = [
			{
				name: "Work",
				tasks: [
					{ content: "do a --> b", status: "blocked", blocker: "x --> y" },
					{
						content: "handle <!-- blocker: sneaky --> properly",
						status: "blocked",
						blocker: "waiting",
					},
				],
			},
		];
		const { phases: parsed, errors } = markdownToPhases(phasesToMarkdown(phases));
		expect(errors).toEqual([]);
		expect(parsed).toEqual(phases);
	});

	it("preserves blocked status across the markdown round-trip", () => {
		const phases: TodoPhase[] = [
			{
				name: "Work",
				tasks: [
					{ content: "a", status: "blocked", blocker: "x" },
					{ content: "b", status: "completed" },
				],
			},
		];
		const md = phasesToMarkdown(phases);
		expect(md).toContain("- [!] a");

		const { phases: parsed, errors } = markdownToPhases(md);
		expect(errors).toEqual([]);
		const parsedA = parsed[0]?.tasks.find((task) => task.content === "a");
		expect(parsedA?.status).toBe("blocked");
		// The blocker reason must survive the round-trip, not just the status.
		expect(parsedA?.blocker).toBe("x");
	});

	it("treats tasks without a preceding heading as the Todos phase", () => {
		const { phases, errors } = markdownToPhases("- [ ] bare task\n");
		expect(errors).toEqual([]);
		expect(phases).toEqual([
			{
				name: "Todos",
				tasks: [{ content: "bare task", status: "in_progress" }],
			},
		]);
	});

	it("reports unknown status markers and unrecognized lines", () => {
		const { phases, errors } = markdownToPhases(
			"# Work\n- [z] weird\nnot a todo\n",
		);
		expect(phases).toEqual([{ name: "Work", tasks: [] }]);
		expect(errors).toHaveLength(2);
		expect(errors[0]).toContain("unknown status marker");
		expect(errors[1]).toContain("unrecognized syntax");
	});

	it("accepts alternate markers: X, >, ~ and bullet styles", () => {
		const { phases, errors } = markdownToPhases(
			"* [X] done\n+ [>] active\n- [~] dropped\n* [ ] plain\n",
		);
		expect(errors).toEqual([]);
		const tasks = phases[0]?.tasks ?? [];
		expect(tasks.map((t) => t.status)).toEqual([
			"completed",
			"in_progress",
			"abandoned",
			"pending",
		]);
	});

	it("normalizes the in-progress pointer after parsing", () => {
		const { phases } = markdownToPhases("# Work\n- [ ] a\n- [/] b\n- [/] c\n");
		// Multiple in_progress markers collapse to the first one in todo order.
		const tasks = phases[0]?.tasks ?? [];
		expect(tasks.map((t) => t.status)).toEqual([
			"pending",
			"in_progress",
			"pending",
		]);
	});
});
