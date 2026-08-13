/**
 * Smoke test: the extension factory runs against a recording ExtensionAPI
 * stub and registers everything it should (tool, command, events), and the
 * event handlers actually dispatch: session sync, eager prelude injection.
 */

import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionHandler,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import todosExtension from "../src/index.ts";
import { makeTestTheme } from "./helpers.ts";

type AnyHandler = ExtensionHandler<any, any>;

function makeRecordingAPI(): {
	api: ExtensionAPI;
	handlers: Map<string, AnyHandler[]>;
	tools: ToolDefinition[];
	commands: string[];
	commandHandlers: Map<
		string,
		(args: string, ctx: ExtensionCommandContext) => Promise<void>
	>;
	eventsEmitted: Array<{ channel: string; data: unknown }>;
} {
	const handlers = new Map<string, AnyHandler[]>();
	const tools: ToolDefinition[] = [];
	const commands: string[] = [];
	const commandHandlers = new Map<
		string,
		(args: string, ctx: ExtensionCommandContext) => Promise<void>
	>();
	const eventsEmitted: Array<{ channel: string; data: unknown }> = [];

	const api: ExtensionAPI = {
		on: ((event: string, handler: AnyHandler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		}) as ExtensionAPI["on"],
		registerTool: (tool: ToolDefinition) => {
			tools.push(tool);
		},
		registerCommand: (
			name: string,
			options: {
				handler: (
					args: string,
					ctx: ExtensionCommandContext,
				) => Promise<void>;
			},
		) => {
			commands.push(name);
			commandHandlers.set(name, options.handler);
		},
		registerShortcut: () => {},
		registerFlag: () => {},
		getFlag: () => undefined,
		registerMessageRenderer: () => {},
		registerMarkdownTransformer: () => {},
		registerEntryRenderer: () => {},
		sendMessage: () => {},
		sendUserMessage: () => {},
		appendEntry: () => {},
		setSessionName: () => {},
		getSessionName: () => undefined,
		setLabel: () => {},
		exec: () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
		getActiveTools: () => ["todo", "bash"],
		getAllTools: () => [],
		setActiveTools: () => {},
		getCommands: () => [],
		setModel: () => Promise.resolve(true),
		getThinkingLevel: () => "off",
		setThinkingLevel: () => {},
		registerProvider: () => {},
		unregisterProvider: () => {},
		events: {
			on: () => () => {},
			emit: (channel: string, data: unknown) => {
				eventsEmitted.push({ channel, data });
			},
			off: () => {},
		},
	} as unknown as ExtensionAPI;

	return { api, handlers, tools, commands, commandHandlers, eventsEmitted };
}

function makeContext(
	overrides: Partial<ExtensionContext> = {},
	sm: Partial<ExtensionContext["sessionManager"]> = {},
): ExtensionContext {
	const sessionManager = {
		getCwd: () => "/tmp",
		getSessionDir: () => "/tmp",
		getSessionId: () => "test",
		getSessionFile: () => "/tmp/session.jsonl",
		getLeafId: () => null,
		getLeafEntry: () => undefined,
		getEntry: () => undefined,
		getLabel: () => undefined,
		getBranch: () => [],
		buildContextEntries: () => [],
		getHeader: () => null,
		getEntries: () => [],
		getTree: () => [],
		getSessionName: () => undefined,
		...sm,
	} as ExtensionContext["sessionManager"];
	return {
		ui: {
			select: () => Promise.resolve(undefined),
			confirm: () => Promise.resolve(false),
			input: () => Promise.resolve(undefined),
			notify: () => {},
			onTerminalInput: () => () => {},
			setStatus: () => {},
			setWorkingMessage: () => {},
			setWorkingVisible: () => {},
			setWorkingIndicator: () => {},
			setHiddenThinkingLabel: () => {},
			setWidget: () => {},
			setFooter: () => {},
			setHeader: () => {},
			setTitle: () => {},
			custom: () => Promise.resolve(undefined),
			pasteToEditor: () => {},
			setEditorText: () => {},
			getEditorText: () => "",
			editor: () => Promise.resolve(undefined),
			addAutocompleteProvider: () => {},
			setEditorComponent: () => {},
			getEditorComponent: () => undefined,
			theme: makeTestTheme(),
			getAllThemes: () => [],
			getTheme: () => undefined,
			setTheme: () => ({ success: true }),
			getToolsExpanded: () => false,
			setToolsExpanded: () => {},
		},
		mode: "print",
		hasUI: false,
		cwd: "/tmp",
		sessionManager,
		modelRegistry: {} as never,
		model: undefined,
		scopedModels: [],
		isIdle: () => true,
		isProjectTrusted: () => true,
		signal: undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
		...overrides,
	} as unknown as ExtensionContext;
}

async function dispatch(
	handlers: Map<string, AnyHandler[]>,
	event: string,
	eventPayload: unknown,
	ctx: ExtensionContext,
) {
	const results: unknown[] = [];
	for (const handler of handlers.get(event) ?? []) {
		results.push(await handler(eventPayload as never, ctx));
	}
	return results;
}

function branchWithTodo(
	phases: unknown,
): { type: string; message: Record<string, unknown> }[] {
	return [
		{
			type: "message",
			message: {
				role: "toolResult",
				toolName: "todo",
				details: { op: "init", phases, storage: "session" },
			},
		},
	];
}

describe("todos extension factory", () => {
	let tempRoot = "";
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

	afterEach(() => {
		if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
		tempRoot = "";
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	});

	function sandboxAgentDir(): string {
		tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "todos-smoke-"));
		const agent = path.join(tempRoot, "agent");
		fs.mkdirSync(agent, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = agent;
		return agent;
	}

	it("registers the todo tool, /todo command, and lifecycle events", () => {
		const { api, handlers, tools, commands } = makeRecordingAPI();
		todosExtension(api);

		for (const event of [
			"session_start",
			"session_tree",
			"session_compact",
			"before_agent_start",
			"tool_result",
			"agent_end",
			"agent_settled",
		]) {
			expect(handlers.has(event)).toBe(true);
		}

		expect(commands).toContain("todo");
		expect(commands).toContain("todos-configure");

		const tool = tools.find((t) => t.name === "todo");
		expect(tool).toBeDefined();
		expect(tool?.label).toBe("Todo");
		expect(tool?.executionMode).toBe("sequential");
		expect(tool?.promptSnippet).toContain("structured todo list");
	});

	it("the tool schema requires op but prepareArguments infers it", () => {
		const { api, tools } = makeRecordingAPI();
		todosExtension(api);
		const tool = tools.find((t) => t.name === "todo");
		expect(tool).toBeDefined();
		if (!tool) return;

		const args = { list: [{ phase: "Work", items: ["a"] }] };
		expect(tool.prepareArguments?.(args)).toEqual({ ...args, op: "init" });
		// Uninferable shapes pass through and fail schema validation.
		expect(tool.prepareArguments?.({ task: "x" })).toEqual({ task: "x" });
	});

	it("emits completion and blocked notifications for successful TUI mutations", async () => {
		const originalTermProgram = process.env.TERM_PROGRAM;
		process.env.TERM_PROGRAM = "kitty";
		try {
			const { api, handlers, tools, eventsEmitted } = makeRecordingAPI();
			todosExtension(api);
			sandboxAgentDir();
			const phases = [
				{
					name: "Work",
					tasks: [
						{ content: "finish", status: "in_progress" },
						{ content: "wait", status: "pending" },
					],
				},
			];
			const ctx = makeContext(
				{ mode: "tui", hasUI: true, cwd: "/tmp/project" },
				{
					getBranch: () => branchWithTodo(phases) as never,
					getCwd: () => "/tmp/project",
					getSessionFile: () => "/tmp/project/session.jsonl",
				},
			);
			await dispatch(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
			const tool = tools.find((candidate) => candidate.name === "todo");
			expect(tool).toBeDefined();
			if (!tool) return;

			await tool.execute!("complete", { op: "done", task: "finish" }, undefined, undefined, ctx);
			await tool.execute!("block", { op: "block", task: "wait", reason: "external input" }, undefined, undefined, ctx);
			await tool.execute!("repeat", { op: "done", task: "finish" }, undefined, undefined, ctx);
			await tool.execute!("view", { op: "view" }, undefined, undefined, ctx);
			let failedOperationThrew = false;
			try {
				await tool.execute!("failed", { op: "block" }, undefined, undefined, ctx);
			} catch {
				failedOperationThrew = true;
			}
			expect(failedOperationThrew).toBe(true);

			expect(eventsEmitted).toEqual([
				{
					channel: "desktop-notify:request",
					data: {
						title: "Todo",
						body: "Completed 1 todo task",
						type: "todo-completed",
						urgency: "normal",
						sound: "info",
					},
				},
				{
					channel: "desktop-notify:request",
					data: {
						title: "Todo",
						body: "Blocked 1 todo task",
						type: "todo-blocked",
						urgency: "normal",
						sound: "warning",
					},
				},
			]);
		} finally {
			if (originalTermProgram === undefined) delete process.env.TERM_PROGRAM;
			else process.env.TERM_PROGRAM = originalTermProgram;
		}
	});

	it("routes /todo completion through the same notification seam", async () => {
		const originalTermProgram = process.env.TERM_PROGRAM;
		process.env.TERM_PROGRAM = "ghostty";
		try {
			const { api, handlers, commandHandlers, eventsEmitted } = makeRecordingAPI();
			todosExtension(api);
			sandboxAgentDir();
			const phases = [
				{ name: "Work", tasks: [{ content: "finish", status: "in_progress" }] },
			];
			const ctx = makeContext(
				{ mode: "tui", hasUI: true, cwd: "/tmp/project" },
				{
					getBranch: () => branchWithTodo(phases) as never,
					getCwd: () => "/tmp/project",
					getSessionFile: () => "/tmp/project/session.jsonl",
				},
			);
			await dispatch(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
			const command = commandHandlers.get("todo");
			expect(command).toBeDefined();
			if (!command) return;
			await command("done finish", ctx as ExtensionCommandContext);
			expect(eventsEmitted).toHaveLength(1);
			expect(eventsEmitted[0]).toEqual({
				channel: "desktop-notify:request",
				data: {
					title: "Todo",
					body: "Completed 1 todo task",
					type: "todo-completed",
					urgency: "normal",
					sound: "info",
				},
			});
		} finally {
			if (originalTermProgram === undefined) delete process.env.TERM_PROGRAM;
			else process.env.TERM_PROGRAM = originalTermProgram;
		}
	});

	it("does not let EventBus delivery failures affect a mutation", async () => {
		const originalTermProgram = process.env.TERM_PROGRAM;
		process.env.TERM_PROGRAM = "kitty";
		try {
			const { api, handlers, tools } = makeRecordingAPI();
			api.events.emit = () => {
				throw new Error("desktop notifier absent");
			};
			todosExtension(api);
			sandboxAgentDir();
			const phases = [
				{ name: "Work", tasks: [{ content: "finish", status: "in_progress" }] },
			];
			const ctx = makeContext(
				{ mode: "tui", hasUI: true, cwd: "/tmp/project" },
				{ getBranch: () => branchWithTodo(phases) as never },
			);
			await dispatch(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
			const tool = tools.find((candidate) => candidate.name === "todo");
			expect(tool).toBeDefined();
			if (!tool) return;
			const result = await tool.execute!("safe", { op: "done", task: "finish" }, undefined, undefined, ctx);
			expect((result.details as { phases: typeof phases }).phases[0]?.tasks[0]?.status).toBe("completed");
		} finally {
			if (originalTermProgram === undefined) delete process.env.TERM_PROGRAM;
			else process.env.TERM_PROGRAM = originalTermProgram;
		}
	});

	it("keeps notification requests silent outside eligible TUI terminals", async () => {
		const originalTermProgram = process.env.TERM_PROGRAM;
		process.env.TERM_PROGRAM = "xterm";
		try {
			const { api, handlers, tools, eventsEmitted } = makeRecordingAPI();
			todosExtension(api);
			sandboxAgentDir();
			const phases = [
				{ name: "Work", tasks: [{ content: "finish", status: "in_progress" }] },
			];
			const ctx = makeContext(
				{ mode: "print", hasUI: false, cwd: "/tmp/project" },
				{
					getBranch: () => branchWithTodo(phases) as never,
					getCwd: () => "/tmp/project",
					getSessionFile: () => "/tmp/project/session.jsonl",
				},
			);
			await dispatch(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
			const tool = tools.find((candidate) => candidate.name === "todo");
			expect(tool).toBeDefined();
			if (!tool) return;
			await tool.execute!("silent", { op: "done", task: "finish" }, undefined, undefined, ctx);
			await dispatch(handlers, "session_tree", { type: "session_tree" }, ctx);
			expect(eventsEmitted).toEqual([]);
		} finally {
			if (originalTermProgram === undefined) delete process.env.TERM_PROGRAM;
			else process.env.TERM_PROGRAM = originalTermProgram;
		}
	});

	it("configures settings through /todos-configure and reloads", async () => {
		const { api, commandHandlers } = makeRecordingAPI();
		todosExtension(api);
		const agent = sandboxAgentDir();
		const ctx = makeContext({ mode: "tui", hasUI: true, cwd: "/tmp/project" });
		let confirms = 0;
		let reloaded = 0;
		ctx.ui.confirm = async () => {
			confirms++;
			return confirms === 1;
		};
		ctx.ui.input = async () => "2";
		ctx.ui.select = async () => "preferred";
		(ctx as ExtensionCommandContext).reload = async () => {
			reloaded++;
		};

		const command = commandHandlers.get("todos-configure");
		expect(command).toBeDefined();
		if (!command) return;
		await command("", ctx as ExtensionCommandContext);
		expect(JSON.parse(fs.readFileSync(path.join(agent, "todo.json"), "utf8"))).toEqual({
			enabled: true,
			reminders: false,
			remindersMax: 2,
			eager: "preferred",
		});
		expect(reloaded).toBe(1);
	});

	it("the todo tool executes against branch-synced state", async () => {
		const { api, handlers, tools } = makeRecordingAPI();
		todosExtension(api);
		sandboxAgentDir();

		const phases = [
			{ name: "Work", tasks: [{ content: "from branch", status: "pending" }] },
		];
		const ctx = makeContext(
			{ cwd: "/tmp/project" },
			{
				getBranch: () => branchWithTodo(phases) as never,
				getCwd: () => "/tmp/project",
				getSessionFile: () => "/tmp/project/session.jsonl",
			},
		);

		await dispatch(
			handlers,
			"session_start",
			{ type: "session_start", reason: "startup" },
			ctx,
		);

		const tool = tools.find((t) => t.name === "todo");
		expect(tool).toBeDefined();
		if (!tool) return;

		const result = await tool.execute!(
			"call-1",
			{ op: "view" },
			undefined,
			undefined,
			ctx,
		);
		const text =
			result.content.find((part) => part.type === "text")?.text ?? "";
		expect(text).toContain("from branch");
		// The branch result itself is the durable record.
		expect((result.details as { phases: unknown }).phases).toEqual(phases);
	});

	it("before_agent_start injects the eager prelude when configured", async () => {
		const { api, handlers } = makeRecordingAPI();
		todosExtension(api);
		const agent = sandboxAgentDir();
		fs.writeFileSync(
			path.join(agent, "todo.json"),
			JSON.stringify({ eager: "always" }),
			"utf8",
		);

		const ctx = makeContext(
			{ cwd: "/tmp/project" },
			{
				getBranch: () => [],
				getCwd: () => "/tmp/project",
				getSessionFile: () => "/tmp/project/session.jsonl",
			},
		);
		await dispatch(
			handlers,
			"session_start",
			{ type: "session_start", reason: "startup" },
			ctx,
		);

		const results = await dispatch(
			handlers,
			"before_agent_start",
			{ type: "before_agent_start", prompt: "Build the feature" },
			ctx,
		);
		const message = (
			results[0] as {
				message?: { customType?: string; content?: string; display?: boolean };
			}
		)?.message;
		expect(message?.customType).toBe("eager-todo-prelude");
		expect(message?.display).toBe(false);
		expect(message?.content).toContain("MUST call `todo` first");
	});

	it("before_agent_start returns nothing on the default config", async () => {
		const { api, handlers } = makeRecordingAPI();
		todosExtension(api);
		sandboxAgentDir();

		const ctx = makeContext(
			{ cwd: "/tmp/project" },
			{
				getBranch: () => [],
				getCwd: () => "/tmp/project",
				getSessionFile: () => "/tmp/project/session.jsonl",
			},
		);
		await dispatch(
			handlers,
			"session_start",
			{ type: "session_start", reason: "startup" },
			ctx,
		);
		const results = await dispatch(
			handlers,
			"before_agent_start",
			{ type: "before_agent_start", prompt: "Build the feature" },
			ctx,
		);
		expect(results[0]).toBeUndefined();
	});

	it("tool_result nudges are steered into the session as custom messages", async () => {
		const sent: Array<{ customType: string; display: boolean }> = [];
		const { api, handlers } = makeRecordingAPI();
		api.sendMessage = (
			message: { customType: string; display: boolean },
			options?: unknown,
		) => {
			sent.push({ customType: message.customType, display: message.display });
			expect(options).toEqual({ deliverAs: "steer" });
		};
		todosExtension(api);
		sandboxAgentDir();

		// Seed state via session_start with an existing todo.
		const ctx = makeContext(
			{ cwd: "/tmp/project" },
			{
				getBranch: () =>
					branchWithTodo([
						{ name: "Work", tasks: [{ content: "a", status: "pending" }] },
					]) as never,
				getCwd: () => "/tmp/project",
				getSessionFile: () => "/tmp/project/session.jsonl",
			},
		);
		await dispatch(
			handlers,
			"session_start",
			{ type: "session_start", reason: "startup" },
			ctx,
		);

		// 12 successful mutating tool results cross the nudge threshold.
		for (let i = 0; i < 12; i++) {
			await dispatch(
				handlers,
				"tool_result",
				{ type: "tool_result", toolName: "edit", isError: false },
				ctx,
			);
		}
		expect(sent).toHaveLength(1);
		expect(sent[0]?.customType).toBe("mid-run-todo-nudge");
	});
});
