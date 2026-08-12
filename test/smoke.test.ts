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
	ExtensionContext,
	ExtensionHandler,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import todosExtension from "../src/index.ts";

type AnyHandler = ExtensionHandler<any, any>;

function makeRecordingAPI(): {
	api: ExtensionAPI;
	handlers: Map<string, AnyHandler[]>;
	tools: ToolDefinition[];
	commands: string[];
} {
	const handlers = new Map<string, AnyHandler[]>();
	const tools: ToolDefinition[] = [];
	const commands: string[] = [];

	const api: ExtensionAPI = {
		on: ((event: string, handler: AnyHandler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		}) as ExtensionAPI["on"],
		registerTool: (tool: ToolDefinition) => {
			tools.push(tool);
		},
		registerCommand: (name: string) => {
			commands.push(name);
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
		events: { on: () => {}, emit: () => {}, off: () => {} },
	} as unknown as ExtensionAPI;

	return { api, handlers, tools, commands };
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
			theme: {} as never,
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
