/**
 * `/todo` command behavior, ported from omp's
 * `test/modes/controllers/todo-command-controller.test.ts`.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	buildSystemReminder,
	getEditorCommand,
	TodoCommandController,
	type TodoCommandHost,
} from "../src/command.ts";
import { USER_TODO_EDIT_CUSTOM_TYPE } from "../src/persistence.ts";
import type { TodoPhase } from "../src/types.ts";

function createHost(
	cwd: string,
	phases: TodoPhase[],
	overrides: Partial<TodoCommandHost> = {},
): TodoCommandHost {
	return {
		getPhases: () => phases,
		setPhases: () => {},
		getBranch: () => [],
		getCwd: () => cwd,
		commit: mock(),
		notify: mock(),
		openEditor: mock(async () => undefined),
		copyToClipboard: mock(() => true),
		openExternalEditor: mock(async () => null),
		...overrides,
	};
}

function reminderTextFrom(host: TodoCommandHost): string | undefined {
	const commit = host.commit as ReturnType<
		typeof mock<(...args: unknown[]) => unknown>
	>;
	const call = commit.mock.calls[0];
	if (!call) return undefined;
	const args = call[1] as string; // action
	const opts = call[2] as { removed?: boolean } | undefined;
	const phases = call[0] as TodoPhase[];
	return buildSystemReminder(args, phases, opts?.removed ?? false);
}

describe("TodoCommandController", () => {
	let tempRoot = "";

	afterEach(async () => {
		if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
		tempRoot = "";
	});

	it("advertises optional default todo import and export paths", async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "todos-help-"));
		const host = createHost(tempRoot, []);
		const controller = new TodoCommandController(host);

		await controller.handleTodoCommand("help");

		expect(
			(host.notify as ReturnType<typeof mock>).mock.calls.some((call) =>
				String(call[0]).includes("/todo export [<path>]"),
			),
		).toBe(true);
		expect(
			(host.notify as ReturnType<typeof mock>).mock.calls.some((call) =>
				String(call[0]).includes("/todo import [<path>]"),
			),
		).toBe(true);
	});

	it("shows the current todos on the bare command", async () => {
		const host = createHost("/tmp", [
			{ name: "Work", tasks: [{ content: "Ship it", status: "pending" }] },
		]);
		const controller = new TodoCommandController(host);

		await controller.handleTodoCommand("");

		const notify = host.notify as ReturnType<typeof mock>;
		expect(
			notify.mock.calls.some((call) =>
				String(call[0]).includes("- [ ] Ship it"),
			),
		).toBe(true);
	});

	it("exports the default TODO.md under the active session cwd", async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "todos-export-"));
		const phases: TodoPhase[] = [
			{ name: "Work", tasks: [{ content: "Ship it", status: "pending" }] },
		];
		const host = createHost(tempRoot, phases);
		const controller = new TodoCommandController(host);

		await controller.handleTodoCommand("export");

		const target = path.join(tempRoot, "TODO.md");
		expect(await fs.readFile(target, "utf8")).toBe("# Work\n- [ ] Ship it\n");
		const notify = host.notify as ReturnType<typeof mock>;
		expect(
			notify.mock.calls.some((call) =>
				String(call[0]).includes(`Wrote todos to ${target}`),
			),
		).toBe(true);
	});

	it("exports a quoted path with spaces", async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "todos-export-quoted-"));
		const phases: TodoPhase[] = [
			{ name: "Work", tasks: [{ content: "Ship it", status: "pending" }] },
		];
		const target = path.join(tempRoot, "todo file.md");
		const host = createHost(tempRoot, phases);
		const controller = new TodoCommandController(host);

		await controller.handleTodoCommand(`export "${target}"`);

		expect(await fs.readFile(target, "utf8")).toBe("# Work\n- [ ] Ship it\n");
	});

	it("imports the default TODO.md under the active session cwd", async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "todos-import-"));
		const target = path.join(tempRoot, "TODO.md");
		await fs.writeFile(target, "# Imported\n- [ ] From cwd\n", "utf8");
		const host = createHost(tempRoot, []);
		const controller = new TodoCommandController(host);

		await controller.handleTodoCommand("import");

		const expected: TodoPhase[] = [
			{
				name: "Imported",
				tasks: [{ content: "From cwd", status: "in_progress" }],
			},
		];
		const commit = host.commit as ReturnType<typeof mock>;
		expect(commit.mock.calls[0]?.[0]).toEqual(expected);
		const notify = host.notify as ReturnType<typeof mock>;
		expect(
			notify.mock.calls.some((call) =>
				String(call[0]).includes(
					`Imported 1 phase(s), 1 task(s) from ${target}.`,
				),
			),
		).toBe(true);
	});

	it("reports import parse errors without committing", async () => {
		tempRoot = await fs.mkdtemp(
			path.join(os.tmpdir(), "todos-import-invalid-"),
		);
		const target = path.join(tempRoot, "TODO.md");
		await fs.writeFile(target, "# Imported\nnot a todo\n", "utf8");
		const host = createHost(tempRoot, []);
		const controller = new TodoCommandController(host);

		await controller.handleTodoCommand("import");

		const notify = host.notify as ReturnType<typeof mock>;
		expect(
			notify.mock.calls.some((call) =>
				String(call[0]).includes(`Could not parse ${target}:`),
			),
		).toBe(true);
		expect(host.commit as ReturnType<typeof mock>).not.toHaveBeenCalled();
	});

	it("reports invalid internal-scheme import paths without committing", async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "todos-import-scheme-"));
		const host = createHost(tempRoot, []);
		const controller = new TodoCommandController(host);

		await controller.handleTodoCommand("import artifact://todo");

		const notify = host.notify as ReturnType<typeof mock>;
		expect(
			notify.mock.calls.some((call) =>
				String(call[0]).includes("Failed to read todos:"),
			),
		).toBe(true);
		expect(
			notify.mock.calls.some((call) =>
				String(call[0]).includes("internal scheme"),
			),
		).toBe(true);
		expect(host.commit as ReturnType<typeof mock>).not.toHaveBeenCalled();
	});

	it("reports invalid internal-scheme export paths", async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "todos-export-scheme-"));
		const phases: TodoPhase[] = [
			{ name: "Work", tasks: [{ content: "Ship it", status: "pending" }] },
		];
		const host = createHost(tempRoot, phases);
		const controller = new TodoCommandController(host);

		await controller.handleTodoCommand("export artifact://todo");

		const notify = host.notify as ReturnType<typeof mock>;
		expect(
			notify.mock.calls.some((call) =>
				String(call[0]).includes("Failed to write todos:"),
			),
		).toBe(true);
		expect(
			notify.mock.calls.some((call) =>
				String(call[0]).includes("internal scheme"),
			),
		).toBe(true);
	});

	it("tells the model not to recreate the list after /todo rm (all)", async () => {
		const phases: TodoPhase[] = [
			{
				name: "Foundation",
				tasks: [{ content: "Scaffold crate", status: "in_progress" }],
			},
		];
		const host = createHost("/tmp", phases);
		const controller = new TodoCommandController(host);

		await controller.handleTodoCommand("rm");

		expect(host.commit as ReturnType<typeof mock>).toHaveBeenCalledTimes(1);
		const text = reminderTextFrom(host);
		expect(text).toContain("intentionally cleared the todo list");
		expect(text).toMatch(/Do NOT recreate/i);
	});

	it("tells the model not to re-add a removed phase after /todo rm <phase>", async () => {
		const phases: TodoPhase[] = [
			{
				name: "Foundation",
				tasks: [{ content: "Scaffold crate", status: "completed" }],
			},
			{
				name: "Auth",
				tasks: [{ content: "Port credential store", status: "pending" }],
			},
		];
		const host = createHost("/tmp", phases);
		const controller = new TodoCommandController(host);

		await controller.handleTodoCommand("rm Auth");

		expect(reminderTextFrom(host)).toMatch(/Do NOT re-add them/i);
	});

	it("keeps status-mutation reminders neutral (no do-not-recreate directive)", async () => {
		const phases: TodoPhase[] = [
			{
				name: "Foundation",
				tasks: [{ content: "Scaffold crate", status: "in_progress" }],
			},
		];
		const host = createHost("/tmp", phases);
		const controller = new TodoCommandController(host);

		await controller.handleTodoCommand("done");

		expect(reminderTextFrom(host)).not.toMatch(/Do NOT/i);
	});

	it("appends a task to the last phase (fuzzy phase matching + auto-create)", async () => {
		let current: TodoPhase[] = [
			{
				name: "Foundation",
				tasks: [{ content: "Scaffold crate", status: "in_progress" }],
			},
		];
		const commit = mock((next: TodoPhase[]) => {
			current = next;
		});
		const host = createHost("/tmp", current, {
			getPhases: () => current,
			commit,
		});
		const controller = new TodoCommandController(host);

		await controller.handleTodoCommand("append Auth Port credential store");
		const next = commit.mock.calls[0]?.[0] as TodoPhase[];
		expect(next.map((p) => p.name)).toEqual(["Foundation", "Auth"]);
		expect(next[1]?.tasks.map((t) => t.content)).toEqual([
			"Port credential store",
		]);

		await controller.handleTodoCommand("append NextTask");
		const next2 = commit.mock.calls[1]?.[0] as TodoPhase[];
		expect(next2[1]?.tasks.map((t) => t.content)).toEqual([
			"Port credential store",
			"NextTask",
		]);
	});

	it("starts a task by fuzzy content match", async () => {
		const phases: TodoPhase[] = [
			{
				name: "Work",
				tasks: [{ content: "Port credential store", status: "pending" }],
			},
		];
		const host = createHost("/tmp", phases);
		const controller = new TodoCommandController(host);

		await controller.handleTodoCommand("start credential");

		const commit = host.commit as ReturnType<typeof mock>;
		const next = commit.mock.calls[0]?.[0] as TodoPhase[];
		expect(next[0]?.tasks[0]?.status).toBe("in_progress");
		expect(commit.mock.calls[0]?.[1]).toBe("/todo start Port credential store");
	});

	it("marks all tasks done with the bare done verb", async () => {
		const phases: TodoPhase[] = [
			{
				name: "Work",
				tasks: [
					{ content: "a", status: "in_progress" },
					{ content: "b", status: "pending" },
				],
			},
		];
		const host = createHost("/tmp", phases);
		const controller = new TodoCommandController(host);

		await controller.handleTodoCommand("done");

		const next = (host.commit as ReturnType<typeof mock>).mock
			.calls[0]?.[0] as TodoPhase[];
		expect(next[0]?.tasks.map((t) => t.status)).toEqual([
			"completed",
			"completed",
		]);
	});

	it("prefers reading state from branch entries when present", async () => {
		const branch: SessionEntry[] = [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "todo",
					details: {
						phases: [
							{
								name: "Branch",
								tasks: [{ content: "from branch", status: "pending" }],
							},
						],
					},
				},
			},
		] as unknown as SessionEntry[];
		const host = createHost(
			"/tmp",
			[{ name: "Memory", tasks: [{ content: "stale", status: "pending" }] }],
			{
				getBranch: () => branch,
			},
		);
		const controller = new TodoCommandController(host);

		await controller.handleTodoCommand("");

		const notify = host.notify as ReturnType<typeof mock>;
		expect(
			notify.mock.calls.some((call) => String(call[0]).includes("from branch")),
		).toBe(true);
		expect(
			notify.mock.calls.some((call) => String(call[0]).includes("stale")),
		).toBe(false);
	});

	it("uses the external editor when openEditor delegates", async () => {
		const phases: TodoPhase[] = [
			{ name: "Work", tasks: [{ content: "a", status: "pending" }] },
		];
		const host = createHost("/tmp", phases, {
			openEditor: mock(async () => "# Work\n- [x] a\n"),
		});
		const controller = new TodoCommandController(host);

		await controller.handleTodoCommand("edit");

		const commit = host.commit as ReturnType<typeof mock>;
		const next = commit.mock.calls[0]?.[0] as TodoPhase[];
		expect(next[0]?.tasks[0]?.status).toBe("completed");
		expect(commit.mock.calls[0]?.[1]).toBe("/todo edit");
	});

	it("warns when the editor is cancelled", async () => {
		const host = createHost("/tmp", [], {
			openEditor: mock(async () => undefined),
		});
		const controller = new TodoCommandController(host);

		await controller.handleTodoCommand("edit");

		const notify = host.notify as ReturnType<typeof mock>;
		expect(
			notify.mock.calls.some((call) =>
				String(call[0]).includes("Editor exited without saving"),
			),
		).toBe(true);
		expect(host.commit as ReturnType<typeof mock>).not.toHaveBeenCalled();
	});

	it("reports an unknown verb", async () => {
		const host = createHost("/tmp", []);
		const controller = new TodoCommandController(host);

		await controller.handleTodoCommand("frobnicate");

		const notify = host.notify as ReturnType<typeof mock>;
		expect(
			notify.mock.calls.some((call) =>
				String(call[0]).includes('Unknown /todo verb "frobnicate"'),
			),
		).toBe(true);
	});
});

describe("getEditorCommand", () => {
	const originalVisual = process.env.VISUAL;
	const originalEditor = process.env.EDITOR;

	afterEach(() => {
		if (originalVisual === undefined) delete process.env.VISUAL;
		else process.env.VISUAL = originalVisual;
		if (originalEditor === undefined) delete process.env.EDITOR;
		else process.env.EDITOR = originalEditor;
	});

	it("prefers VISUAL over EDITOR", () => {
		process.env.VISUAL = "vim";
		process.env.EDITOR = "nano";
		expect(getEditorCommand()).toBe("vim");
	});

	it("falls back to EDITOR", () => {
		delete process.env.VISUAL;
		process.env.EDITOR = "code --wait";
		expect(getEditorCommand()).toBe("code --wait");
	});

	it("returns undefined when neither is set", () => {
		delete process.env.VISUAL;
		delete process.env.EDITOR;
		expect(getEditorCommand()).toBeUndefined();
	});
});

describe("USER_TODO_EDIT_CUSTOM_TYPE", () => {
	it("matches the omp custom type name", () => {
		expect(USER_TODO_EDIT_CUSTOM_TYPE).toBe("user_todo_edit");
	});
});
