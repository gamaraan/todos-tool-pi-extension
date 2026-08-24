/**
 * todos — an Oh My Pi (OMP)-style todo tool, tracker, and HUD for pi.
 *
 * Replicates the OMP todo experience as a pi extension package:
 *
 * - **`todo` tool** (`init|start|done|rm|drop|block|unblock|append|view`)
 *   with phased lists, auto-promotion of the next task, completion
 *   transitions, strict batch semantics, and a collapsed TUI viewport.
 *   Persistence is the tool result itself: every successful result carries
 *   `details.phases`, and state is reconstructed by scanning the session
 *   branch (the same durable-record pattern OMP and pi's example extensions
 *   use — branching/rewinding always shows the correct todo state).
 * - **Eager prelude** (`todo.eager: "preferred" | "always"`): on the first
 *   turn, a hidden reminder asks the model to lay out a phased plan with a
 *   single `init` call before working. pi's extension API cannot force a
 *   `tool_choice`, so `"always"` injects a MUST-call reminder instead.
 * - **Mid-run nudge**: after 12 mutating tool results, a hidden steer
 *   message asks the agent to mark finished tasks done (≤2 per prompt
 *   cycle).
 * - **Completion reminder**: when the agent settles with incomplete todos
 *   and isn't waiting on the user, a reminder is injected and a fresh turn
 *   is triggered (`todo.reminders`, `todo.remindersMax`).
 * - **`/todo` command**: view, native-editor edit, copy, export/import
 *   (Markdown round-trip), fuzzy add/start/done/drop/rm. Manual edits
 *   persist as `user_todo_edit` custom entries and inject a hidden reminder
 *   telling the model what changed (and not to recreate removed items).
 * - **HUD widget**: a compact per-phase checklist with progress above the
 *   editor, kept in sync with every state change.
 * - **Optional desktop notifications**: successful completion and blocked
 *   transitions request named notifications with task names on OSC
 *   9/99-capable TUI terminals; blocker reasons never leave this extension.
 *
 * Config lives in `<agent dir>/todo.json` (global) and `<cwd>/.pi/todo.json`
 * (project, trusted only): `enabled`, `reminders`, `remindersMax`, `eager`.
 * CLI flags take precedence over environment variables and JSON config.
 *
 * @module todos
 */

import type {
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	defineTool,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
	buildSystemReminder,
	TodoCommandController,
	getEditorCommand,
	openInExternalEditor,
} from "./command.ts";
import {
	readTodoConfig,
	resolveTodoConfig,
	saveTodoConfig,
	TODO_CONFIG_DEFAULTS,
	TODO_FLAGS,
	type TodoConfig,
} from "./config.ts";
import { executeTodoOp } from "./execute.ts";
import { TODO_REMINDER_CUSTOM_TYPE, TodoTracker } from "./tracker.ts";
import { USER_TODO_EDIT_CUSTOM_TYPE } from "./persistence.ts";
import { clonePhases, inferTodoOp, isClosedTodo } from "./state.ts";
import {
	deriveTodoNotifications,
	supportsTodoTerminalNotifications,
} from "./notifications.ts";
import { TODO_TOOL_DESCRIPTION } from "./prompts.ts";
import {
	phaseRomanNumeral,
	replaceTabs,
	sanitizeText,
	todoRenderCall,
	todoRenderResult,
	type TodoRenderCallArgs,
} from "./render.ts";
import {
	todoSchema,
	type TodoParams,
	type TodoPhase,
	type TodoToolDetails,
} from "./types.ts";

/** Minimal structural view of pi's ToolRenderContext (not exported from the package index). */
interface ToolRenderContextLike {
	args: unknown;
	isError: boolean;
}

/** Minimal structural view of pi's ToolRenderResultOptions (spinnerFrame is ours). */
export interface TodoRenderResultOptions {
	expanded: boolean;
	isPartial: boolean;
}

const HUD_WIDGET_KEY = "todo-hud";
const USER_TODO_EDIT_REMINDER_TYPE = "user-todo-edit";
const DESKTOP_NOTIFY_EVENT = "desktop-notify:request";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export default function todosExtension(pi: ExtensionAPI): void {
	pi.registerFlag(TODO_FLAGS.enabled, {
		type: "string",
		description:
			"Enable or disable the todos tool (on|off). Overrides PI_TODO_ENABLED and todo.json.",
	});
	pi.registerFlag(TODO_FLAGS.reminders, {
		type: "string",
		description:
			"Enable or disable incomplete-todo reminders (on|off). Overrides PI_TODO_REMINDERS and todo.json.",
	});
	pi.registerFlag(TODO_FLAGS.remindersMax, {
		type: "string",
		description:
			"Maximum incomplete-todo reminders per cycle. Overrides PI_TODO_REMINDERS_MAX and todo.json.",
	});
	pi.registerFlag(TODO_FLAGS.eager, {
		type: "string",
		description:
			"Todo eager mode (default|preferred|always). Overrides PI_TODO_EAGER and todo.json.",
	});

	// =========================================================================
	// Canonical in-memory state
	// =========================================================================

	let phases: TodoPhase[] = [];
	let config: TodoConfig = TODO_CONFIG_DEFAULTS;
	let lastAssistant: AssistantMessage | undefined;

	function getPhases(): TodoPhase[] {
		return clonePhases(phases);
	}

	function setPhases(next: TodoPhase[], ctx?: ExtensionContext): void {
		phases = clonePhases(next);
		if (ctx) updateHud(ctx);
	}

	function emitTodoNotifications(
		previous: TodoPhase[],
		next: TodoPhase[],
		ctx: ExtensionContext,
	): void {
		if (
			ctx.mode !== "tui" ||
			!ctx.hasUI ||
			!supportsTodoTerminalNotifications(process.env)
		)
			return;
		for (const payload of deriveTodoNotifications(previous, next)) {
			try {
				pi.events.emit(DESKTOP_NOTIFY_EVENT, payload);
			} catch {
				// Optional EventBus delivery must never affect the todo mutation.
			}
		}
	}

	// =========================================================================
	// HUD widget
	// =========================================================================

	/**
	 * Lines pi's widget viewport shows before appending "... (widget truncated)".
	 * Mirrors `InteractiveMode.MAX_WIDGET_LINES` (private upstream); if that
	 * constant changes, bump this to match or the fits/no-scroll boundary drifts.
	 */
	const WIDGET_MAX_LINES = 10;

	function updateHud(ctx: ExtensionContext): void {
		// Keep the full plan and its original phase numbers. While the whole list
		// fits the widget there is nothing to gain by hiding completed phases, so
		// render every phase and task and let the completed work stay in view.
		// Once it outgrows the widget, scroll the HUD past completed phases and
		// rows: the first visible phase becomes the current work window, and later
		// phases retain all rows until they become current.
		if (ctx.mode === "print" || ctx.mode === "json") {
			ctx.ui.setWidget(HUD_WIDGET_KEY, undefined);
			return;
		}
		const hasOpenTask = phases.some((phase) =>
			phase.tasks.some((task) => !isClosedTodo(task)),
		);
		if (!hasOpenTask) {
			ctx.ui.setWidget(HUD_WIDGET_KEY, undefined);
			return;
		}
		const theme = ctx.ui.theme;
		const display = (text: string): string => replaceTabs(sanitizeText(text));
		const title = theme.fg("toolTitle", theme.bold("Todo"));
		const totalTasks = phases.reduce(
			(total, phase) => total + phase.tasks.length,
			0,
		);
		const totalClosed = phases.reduce(
			(total, phase) =>
				total + phase.tasks.filter((task) => isClosedTodo(task)).length,
			0,
		);
		// Full unscrolled line count: one title line plus, per non-empty phase,
		// a header line and one line per task. When that fits the widget, skip the
		// scroll so completed phases stop scrolling out of view.
		const fullLineCount =
			1 +
			phases.reduce(
				(total, phase) =>
					total + (phase.tasks.length > 0 ? 1 + phase.tasks.length : 0),
				0,
			);
		const scroll = fullLineCount > WIDGET_MAX_LINES;
		const firstOpenPhaseIndex = scroll
			? phases.findIndex((phase) =>
					phase.tasks.some((task) => !isClosedTodo(task)),
			)
			: -1;
		const visiblePhases = scroll
			? phases
					.map((phase, index) => ({
						phase,
						index,
						openTasks: phase.tasks.filter((task) => !isClosedTodo(task)),
					}))
					.filter(
						({ index, openTasks }) =>
							index >= firstOpenPhaseIndex && openTasks.length > 0,
					)
			: phases
					.map((phase, index) => ({
						phase,
						index,
						openTasks: phase.tasks.filter((task) => !isClosedTodo(task)),
					}))
					.filter(({ phase }) => phase.tasks.length > 0);
		const lines: string[] = [];
		for (const visiblePhase of visiblePhases) {
			const { phase, index, openTasks } = visiblePhase;
			const done = phase.tasks.length - openTasks.length;
			const header = theme.fg(
				"accent",
				theme.bold(`${phaseRomanNumeral(index + 1)}. ${display(phase.name)}`),
			);
			lines.push(
				`${header}  ${theme.fg("dim", `${done}/${phase.tasks.length}`)}`,
			);
			const tasks = index === firstOpenPhaseIndex ? openTasks : phase.tasks;
			for (const task of tasks) {
				const label = display(task.content);
				switch (task.status) {
					case "completed":
						lines.push(
							`  ${theme.fg("success", "✓")} ${theme.fg("dim", theme.strikethrough(label))}`,
						);
						break;
					case "in_progress":
						lines.push(
							`  ${theme.fg("accent", "○")} ${theme.fg("text", label)}`,
						);
						break;
					case "abandoned":
						lines.push(
							`  ${theme.fg("error", "○")} ${theme.fg("dim", theme.strikethrough(label))}`,
						);
						break;
					case "blocked": {
						const note = task.blocker
							? `blocked: ${display(task.blocker)}`
							: "blocked";
						lines.push(
							`  ${theme.fg("warning", "○")} ${theme.fg("muted", `${label} (${note})`)}`,
						);
						break;
					}
					default:
						lines.push(`  ${theme.fg("dim", "○")} ${theme.fg("muted", label)}`);
				}
			}
		}
		const summary = theme.fg("muted", `${totalClosed}/${totalTasks} done`);
		lines.unshift(`${title}  ${summary}`);
		ctx.ui.setWidget(HUD_WIDGET_KEY, lines, { placement: "aboveEditor" });
	}

	// =========================================================================
	// Tracker host
	// =========================================================================

	const tracker = new TodoTracker({
		config: () => config,
		getPhases,
		setPhases: (next: TodoPhase[]) => setPhases(next),
		getBranch: (ctx) => ctx.sessionManager.getBranch(),
		hasPendingMessages: (ctx) => ctx.hasPendingMessages(),
		getActiveToolNames: () => pi.getActiveTools(),
		sendReminder: async (_ctx, reminderText) => {
			pi.sendMessage(
				{
					customType: TODO_REMINDER_CUSTOM_TYPE,
					content: reminderText,
					display: false,
				},
				{ triggerTurn: true },
			);
		},
	});

	// =========================================================================
	// todo tool
	// =========================================================================

	const todoTool = defineTool({
		name: "todo",
		label: "Todo",
		description: TODO_TOOL_DESCRIPTION,
		promptSnippet:
			"Write a structured todo list to track progress within a session",
		promptGuidelines: [
			"Use the todo tool to track multi-step work as a phased list; update it as the work progresses.",
			"When the user provides a multi-step plan or enumerates N items/bugs/tasks, initialize every item as its own todo task before working.",
			"Mark tasks done immediately after finishing them; batch todo calls with real work instead of making solo todo turns.",
		],
		parameters: todoSchema,
		executionMode: "sequential",

		// Repairs a missing `op` (models routinely send `{list:[...]}` with no
		// op) before schema validation, mirroring omp's `lenientArgValidation`
		// + `resolveTodoParams` behavior. Uninferable shapes return as-is and
		// fail schema validation for a normal model retry.
		prepareArguments(args: unknown): TodoParams {
			if (isRecord(args) && args.op === undefined) {
				const inferred = inferTodoOp(args, phases.length > 0);
				if (inferred) return { ...args, op: inferred } as TodoParams;
			}
			return args as TodoParams;
		},

		async execute(
			_toolCallId: string,
			params: TodoParams,
			_signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback<TodoToolDetails> | undefined,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<TodoToolDetails>> {
			const previousPhases = getPhases();
			const outcome = executeTodoOp(
				previousPhases,
				params,
				Boolean(ctx.sessionManager.getSessionFile()),
			);
			// pi signals tool errors by throwing; the model receives the message
			// text (omp's formatSummary output, errors + full current list).
			if (outcome.failed) throw new Error(outcome.summary);
			if (!outcome.readOnly) {
				setPhases(outcome.phases, ctx);
				emitTodoNotifications(previousPhases, outcome.phases, ctx);
			}
			const details: TodoToolDetails = {
				op: outcome.op,
				phases: outcome.phases,
				storage: outcome.storage,
			};
			if (outcome.completedTasks.length > 0)
				details.completedTasks = outcome.completedTasks;

			return {
				content: [{ type: "text", text: outcome.summary }],
				details,
			};
		},

		renderCall(args: TodoParams, theme: Theme): Component {
			return todoRenderCall(args as unknown as TodoRenderCallArgs, theme);
		},

		renderResult(
			result: AgentToolResult<TodoToolDetails>,
			options: TodoRenderResultOptions,
			theme: Theme,
			context: ToolRenderContextLike,
		): Component {
			return todoRenderResult(
				result,
				options,
				theme,
				context.args as unknown as TodoRenderCallArgs,
				context.isError,
			);
		},
	});

	pi.registerTool(todoTool);

	// =========================================================================
	// /todo command
	// =========================================================================

	pi.registerCommand("todos-configure", {
		description: "Configure and persist todos settings",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI || ctx.mode !== "tui") {
				ctx.ui.notify(
					"/todos-configure requires interactive TUI mode.",
					"warning",
				);
				return;
			}
			const current: TodoConfig = {
				...TODO_CONFIG_DEFAULTS,
				...readTodoConfig(),
			};
			const enabled = await ctx.ui.confirm(
				"Todos tool",
				`Enable the todos tool? Currently ${current.enabled ? "on" : "off"}.`,
			);
			const reminders = await ctx.ui.confirm(
				"Todo reminders",
				`Enable incomplete-todo reminders? Currently ${current.reminders ? "on" : "off"}.`,
			);
			const remindersMaxInput = await ctx.ui.input(
				"Maximum reminders",
				String(current.remindersMax),
			);
			if (remindersMaxInput === undefined) return;
			const remindersMax = Number(remindersMaxInput.trim());
			if (!Number.isInteger(remindersMax) || remindersMax < 0) {
				ctx.ui.notify(
					"Maximum reminders must be a non-negative integer.",
					"error",
				);
				return;
			}
			const eager = await ctx.ui.select("First-turn todo planning", [
				"default",
				"preferred",
				"always",
			]);
			if (eager === undefined) return;
			if (eager !== "default" && eager !== "preferred" && eager !== "always") {
				ctx.ui.notify("Invalid eager mode selected.", "error");
				return;
			}
			saveTodoConfig({ enabled, reminders, remindersMax, eager });
			ctx.ui.notify("Todos configuration saved. Reloading…", "info");
			await ctx.reload();
		},
	});

	pi.registerCommand("todo", {
		description: "View, edit, import/export, and mutate the todo list",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const controller = new TodoCommandController({
				getPhases,
				setPhases: (next: TodoPhase[]) => setPhases(next, ctx),
				getBranch: () => ctx.sessionManager.getBranch(),
				getCwd: () => ctx.cwd,
				commit: (
					nextPhases: TodoPhase[],
					action: string,
					opts?: { removed?: boolean },
				) => {
					setPhases(nextPhases, ctx);
					pi.appendEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: nextPhases });
					pi.sendMessage(
						{
							customType: USER_TODO_EDIT_REMINDER_TYPE,
							content: buildSystemReminder(
								action,
								nextPhases,
								opts?.removed ?? false,
							),
							display: false,
						},
						{ triggerTurn: false },
					);
				},
				onSuccessfulMutation: (previous, next) =>
					emitTodoNotifications(previous, next, ctx),
				notify: (text: string, type: "info" | "warning" | "error") => {
					if (ctx.hasUI) ctx.ui.notify(text, type);
					else console.error(text);
				},
				openEditor: async (
					title: string,
					prefill: string,
				): Promise<string | undefined> => {
					if (ctx.mode === "tui") {
						return ctx.ui.editor(title, prefill);
					}
					const editorCmd = getEditorCommand();
					if (!editorCmd) {
						ctx.ui.notify(
							"No editor configured. Set $VISUAL or $EDITOR environment variable.",
							"warning",
						);
						return undefined;
					}
					const edited = await openInExternalEditor(editorCmd, prefill);
					return edited === null ? undefined : edited;
				},
				copyToClipboard: (text: string): boolean => {
					if (ctx.mode !== "tui") return false;
					const base64 = Buffer.from(text, "utf8").toString("base64");
					process.stdout.write(`\x1b]52;c;${base64}\x07`);
					return true;
				},
				openExternalEditor: (prefill: string) =>
					openInExternalEditor(getEditorCommand() ?? "vi", prefill),
			});
			await controller.handleTodoCommand(args);
		},
	});

	// =========================================================================
	// Session lifecycle
	// =========================================================================

	pi.on("session_start", async (_event, ctx) => {
		const loaded = resolveTodoConfig(
			ctx.cwd,
			() => ctx.isProjectTrusted(),
			(message) => {
				if (ctx.hasUI) ctx.ui.notify(message, "warning");
				else console.error(message);
			},
			(name) => pi.getFlag(name),
		);
		config = loaded.config;
		if (!config.enabled) {
			const active = pi.getActiveTools();
			if (active.includes("todo")) {
				pi.setActiveTools(active.filter((name) => name !== "todo"));
			}
		}
		tracker.syncFromBranch(ctx);
		updateHud(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		tracker.syncFromBranch(ctx);
		updateHud(ctx);
	});

	pi.on("session_compact", async (_event, ctx) => {
		tracker.syncFromBranch(ctx);
		updateHud(ctx);
	});

	// =========================================================================
	// Prompt lifecycle
	// =========================================================================

	pi.on("before_agent_start", async (event, ctx) => {
		tracker.resetCycle();
		const prelude = tracker.createEagerTodoPrelude(event.prompt, ctx);
		return prelude ? { message: prelude } : undefined;
	});

	pi.on("tool_result", async (event, ctx) => {
		tracker.onToolResult(event.toolName, event.isError);
		const nudge = tracker.takeMidRunNudge(ctx);
		if (nudge) {
			pi.sendMessage(nudge, { deliverAs: "steer" });
		}
	});

	pi.on("agent_end", async (event) => {
		for (let i = event.messages.length - 1; i >= 0; i--) {
			const message = event.messages[i];
			if (message !== undefined && message.role === "assistant") {
				lastAssistant = message as AssistantMessage;
				break;
			}
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const reminded = await tracker.checkCompletion(ctx, lastAssistant);
		if (reminded) updateHud(ctx);
	});
}
