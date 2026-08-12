/**
 * TodoTracker — owns canonical todo state, the eager first-turn prelude,
 * mid-run nudges, and stop-time completion reminders.
 *
 * Ported from Oh My Pi's `packages/coding-agent/src/session/todo-tracker.ts`
 * and adapted to pi's extension API:
 *
 * - omp's `scheduleAgentContinue` → `pi.sendMessage(..., { triggerTurn: true })`
 *   from the `agent_settled` handler.
 * - omp's pre-prompt maintenance thunk → pi's `before_agent_start` extension
 *   event (the handler result's `message` is injected into the turn).
 * - `planModeEnabled()`, `hasPendingAsyncWake()`, `agentKind()`, and
 *   `consumeLastServedToolChoiceLabel()` are stubbed (no plan mode, no async
 *   jobs, no subagents in scope): plan mode → false, async wake → false,
 *   kind → "main", tool-choice label → undefined.
 * - The eager `always` mode cannot force a `tool_choice` through pi's
 *   extension API; it injects the MUST-call reminder text instead.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { TodoConfig } from "./config.ts";
import { renderEagerTodoPrompt, renderMidRunNudgePrompt } from "./prompts.ts";
import { getLatestTodoPhasesFromEntries } from "./persistence.ts";
import { clonePhases, isTodoPhase } from "./state.ts";
import type { TodoItem, TodoPhase } from "./types.ts";

const MID_RUN_NUDGE_MUTATION_THRESHOLD = 12;
const MID_RUN_NUDGE_MAX_PER_CYCLE = 2;
const MUTATING_TOOLS: Record<string, true> = {
	bash: true,
	eval: true,
	edit: true,
	write: true,
};

export const EAGER_TODO_PRELUDE_CUSTOM_TYPE = "eager-todo-prelude";
export const MID_RUN_NUDGE_MESSAGE_TYPE = "mid-run-todo-nudge";
export const TODO_REMINDER_CUSTOM_TYPE = "todo-reminder";

/** An invisible message injected into the LLM context. */
export interface TodoInjectedMessage {
	customType: string;
	content: string;
	display: false;
}

/** Capabilities the todo tracker borrows from the hosting extension. */
export interface TodoTrackerHost {
	config(): TodoConfig;
	getPhases(): TodoPhase[];
	setPhases(phases: TodoPhase[]): void;
	getBranch(ctx: ExtensionContext): SessionEntry[];
	hasPendingMessages(ctx: ExtensionContext): boolean;
	getActiveToolNames(ctx: ExtensionContext): string[];
	/** Send the completion-reminder message and trigger a fresh agent turn. */
	sendReminder(ctx: ExtensionContext, reminderText: string): Promise<void>;
}

/** Whether the last assistant line reads as a question/response cue the user must answer. */
export function isAwaitingUserAnswer(message: AssistantMessage): boolean {
	const text = assistantText(message);
	if (!text) return false;
	const lastLine = text.split(/\r?\n/).at(-1)?.trim();
	return (
		lastLine !== undefined &&
		(isQuestionPromptLine(lastLine) || isResponseCueLine(lastLine))
	);
}

// ---------------------------------------------------------------------------
// Prompt-line heuristics (ported from omp todo-tracker.ts)
// ---------------------------------------------------------------------------

const MARKDOWN_PROMPT_PREFIX_RE = /^(?:>\s*)?(?:(?:[-*+]|\d+[.)])\s+)*/;
const PROMPT_LABEL_RE = /^(?:q(?:uestion)?|ask)\s*\d*\s*[:.)-]\s*/i;
const QUESTION_PROMPT_RE =
	/^(?:what|which|when|where|why|how|who|whom|whose|do|does|did|can|could|would|will|should|is|are|am|may|shall)\b/i;
const USER_DIRECTED_PROMPT_RE = /\b(?:you|your|we|our)\b/i;
const USER_RESPONSE_CUE_RE =
	/^(?:please\s+)?(?:confirm|reply|choose|pick|decide|advise)\b|^(?:please\s+)?answer\b|^(?:please\s+)?(?:let\s+me\s+know|tell\s+me)\b/i;
const NON_ASCII_TEXT_RE = /[^\x00-\x7F]/;

interface PromptLine {
	text: string;
	hadPromptLabel: boolean;
}

function promptLine(line: string): PromptLine {
	const withoutMarkdownPrefix = line
		.trim()
		.replace(MARKDOWN_PROMPT_PREFIX_RE, "")
		.trim();
	const withoutPromptLabel = withoutMarkdownPrefix
		.replace(PROMPT_LABEL_RE, "")
		.trim();
	return {
		text: withoutPromptLabel,
		hadPromptLabel: withoutPromptLabel !== withoutMarkdownPrefix,
	};
}

function isQuestionPromptLine(line: string): boolean {
	const candidate = promptLine(line);
	if (!/[?？]\s*$/.test(candidate.text)) return false;
	return (
		candidate.hadPromptLabel ||
		QUESTION_PROMPT_RE.test(candidate.text) ||
		USER_DIRECTED_PROMPT_RE.test(candidate.text) ||
		NON_ASCII_TEXT_RE.test(candidate.text)
	);
}

function isResponseCueLine(line: string): boolean {
	const candidate = promptLine(line)
		.text.replace(/[.!?。！？]+$/, "")
		.trim();
	return USER_RESPONSE_CUE_RE.test(candidate);
}

function assistantText(message: AssistantMessage): string {
	return message.content
		.filter((content): content is TextContent => content.type === "text")
		.map((content) => content.text)
		.join("\n")
		.trim();
}

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------

/** Owns canonical todo state, eager preludes, and completion reminders. */
export class TodoTracker {
	readonly #host: TodoTrackerHost;
	#phases: TodoPhase[] = [];
	#reminderCount = 0;
	#reminderAwaitingProgress = false;
	#mutationsSinceLastTouch = 0;
	#midRunNudgeCount = 0;

	constructor(host: TodoTrackerHost) {
		this.#host = host;
	}

	/** Returns a defensive clone of the current todo phases. */
	get phases(): TodoPhase[] {
		return clonePhases(this.#phases);
	}

	/** Replaces todo phases with a defensive clone. */
	setPhases(phases: TodoPhase[]): void {
		this.#phases = clonePhases(phases);
		this.#host.setPhases(this.#phases);
	}

	/** Rehydrates todo phases from the current transcript branch. */
	syncFromBranch(ctx: ExtensionContext): void {
		this.setPhases(getLatestTodoPhasesFromEntries(this.#host.getBranch(ctx)));
	}

	/** Resets per-prompt reminder and mutation budgets. */
	resetCycle(): void {
		this.#reminderCount = 0;
		this.#reminderAwaitingProgress = false;
		this.#mutationsSinceLastTouch = 0;
		this.#midRunNudgeCount = 0;
	}

	/** Records a completed tool result before asynchronous event processing begins. */
	onToolResult(toolName: string, isError: boolean): void {
		if (toolName === "todo") {
			this.#mutationsSinceLastTouch = 0;
		} else if (!isError && MUTATING_TOOLS[toolName]) {
			this.#mutationsSinceLastTouch++;
		}
		this.#reminderAwaitingProgress = false;
	}

	/** Builds the first-turn eager todo prelude message, or undefined. */
	createEagerTodoPrelude(
		promptText: string | undefined,
		ctx: ExtensionContext,
	): TodoInjectedMessage | undefined {
		const settings = this.#host.config();
		const mode = settings.eager;
		if (mode === "default" || !settings.enabled) return undefined;
		if (this.#phases.length > 0) return undefined;
		if (promptText !== undefined) {
			if (
				this.#host
					.getBranch(ctx)
					.some(
						(entry) =>
							entry.type === "message" && entry.message.role === "user",
					)
			) {
				return undefined;
			}
			const trimmedPromptText = promptText.trimEnd();
			if (trimmedPromptText.endsWith("?") || trimmedPromptText.endsWith("!"))
				return undefined;
		}
		if (!this.#host.getActiveToolNames(ctx).includes("todo")) return undefined;
		return {
			customType: EAGER_TODO_PRELUDE_CUSTOM_TYPE,
			content: renderEagerTodoPrompt({
				toolRef: "todo",
				forced: mode === "always",
			}),
			display: false,
		};
	}

	/** Takes the next hidden mid-run reconciliation nudge, if its budget and guards allow. */
	takeMidRunNudge(ctx: ExtensionContext): TodoInjectedMessage | null {
		if (this.#mutationsSinceLastTouch < MID_RUN_NUDGE_MUTATION_THRESHOLD)
			return null;
		if (this.#midRunNudgeCount >= MID_RUN_NUDGE_MAX_PER_CYCLE) return null;
		const settings = this.#host.config();
		if (!settings.enabled || !settings.reminders) return null;
		if (!this.#host.getActiveToolNames(ctx).includes("todo")) return null;
		const incomplete = this.#phases
			.flatMap((phase) => phase.tasks)
			.filter(
				(task) => task.status === "pending" || task.status === "in_progress",
			);
		if (incomplete.length === 0) return null;
		this.#mutationsSinceLastTouch = 0;
		this.#midRunNudgeCount++;
		return {
			customType: MID_RUN_NUDGE_MESSAGE_TYPE,
			content: renderMidRunNudgePrompt({
				toolRef: "todo",
				incompleteCount: incomplete.length,
			}),
			display: false,
		};
	}

	/**
	 * Checks a terminal assistant turn and schedules a continuation for
	 * incomplete todos. Returns true when a reminder was sent.
	 */
	async checkCompletion(
		ctx: ExtensionContext,
		lastAssistant: AssistantMessage | undefined,
	): Promise<boolean> {
		const settings = this.#host.config();
		if (!settings.reminders || !settings.enabled) {
			this.#reminderCount = 0;
			this.#reminderAwaitingProgress = false;
			return false;
		}
		if (this.#reminderAwaitingProgress) return false;
		if (this.#reminderCount >= settings.remindersMax) return false;
		const phases = this.phases;
		if (phases.length === 0) {
			this.#reminderCount = 0;
			this.#reminderAwaitingProgress = false;
			return false;
		}
		const incompleteByPhase = phases
			.map((phase) => ({
				name: phase.name,
				tasks: phase.tasks
					.filter(
						(task): task is TodoItem & { status: "pending" | "in_progress" } =>
							task.status === "pending" || task.status === "in_progress",
					)
					.map((task) => ({ content: task.content, status: task.status })),
			}))
			.filter((phase) => phase.tasks.length > 0);
		const incomplete = incompleteByPhase.flatMap((phase) => phase.tasks);
		if (incomplete.length === 0) {
			this.#reminderCount = 0;
			this.#reminderAwaitingProgress = false;
			return false;
		}
		if (lastAssistant && isAwaitingUserAnswer(lastAssistant)) return false;
		if (this.#host.hasPendingMessages(ctx)) return false;
		this.#reminderCount++;
		const todoList = incompleteByPhase
			.map(
				(phase) =>
					`- ${phase.name}\n${phase.tasks.map((task) => `  - ${task.content}`).join("\n")}`,
			)
			.join("\n");
		const reminder =
			`<system-reminder>\n` +
			`You stopped with ${incomplete.length} incomplete todo item(s):\n${todoList}\n\n` +
			`Please continue working on these tasks or mark them complete if finished.\n` +
			`(Reminder ${this.#reminderCount}/${settings.remindersMax})\n` +
			`</system-reminder>`;
		this.#mutationsSinceLastTouch = 0;
		this.#reminderAwaitingProgress = true;
		await this.#host.sendReminder(ctx, reminder);
		return true;
	}
}

// Re-exported for consumers that validate persisted phases.
export { isTodoPhase };
