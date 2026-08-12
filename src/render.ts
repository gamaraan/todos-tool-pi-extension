/**
 * TUI renderers for the todo tool (`renderCall` / `renderResult`), ported
 * from Oh My Pi's `todoToolRenderer` (`tools/todo.ts` renderer section).
 *
 * Adaptations for pi:
 * - Renders a plain multi-line `Text` component instead of omp's
 *   `framedBlock`/`renderStatusLine`/`renderTreeList` chrome (pi's tool
 *   execution row already provides the shell).
 * - No strike-through *reveal* animation: pi's render options carry no
 *   spinner frame counter, so completed tasks render struck-through
 *   immediately. The per-frame helpers are kept for tests.
 * - Phase collapsing, roman-numeral headers, progress counters, and the
 *   walking collapsed viewport (`selectCollapsedTodos`) are preserved.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Text, type Component } from "@earendil-works/pi-tui";
import {
	COLLAPSED_ITEMS_CAP,
	isClosedTodo,
	selectCollapsedTodos,
} from "./state.ts";
import type {
	TodoCompletionTransition,
	TodoItem,
	TodoPhase,
	TodoToolDetails,
} from "./types.ts";

// =============================================================================
// Sanitization helpers (port of omp's pi-utils `sanitizeText` + `replaceTabs`)
// =============================================================================

const ANSI_RE =
	/\x1b(?:\[[0-9;:?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|\([A-Za-z]|#[0-9A-Fa-f]{0,6})/g;
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;

/** Strip ANSI escapes and C0/C1 controls, preserving tabs/newlines. */
export function sanitizeText(text: string): string {
	return text.replace(ANSI_RE, "").replace(CONTROL_RE, "");
}

/** Replace tabs with two spaces (omp's `replaceTabs` default). */
export function replaceTabs(text: string, spaces = 2): string {
	return text.replace(/\t/g, " ".repeat(spaces));
}

/**
 * Every render boundary in this file funnels display text through here:
 * sanitize strips ANSI/C0 sequences (a raw label holding provider text could
 * otherwise rewrite the terminal), and tabs are replaced so they cannot punch
 * holes in rendered output. The raw value stays untouched everywhere else:
 * task content and phase names are the identity keys the local list is
 * looked up by, and what gets persisted.
 */
function forDisplay(text: string): string {
	return replaceTabs(sanitizeText(text));
}

// =============================================================================
// Phase numbering (display-only)
// =============================================================================

const ROMAN_PAIRS: Array<[number, string]> = [
	[1000, "M"],
	[900, "CM"],
	[500, "D"],
	[400, "CD"],
	[100, "C"],
	[90, "XC"],
	[50, "L"],
	[40, "XL"],
	[10, "X"],
	[9, "IX"],
	[5, "V"],
	[4, "IV"],
	[1, "I"],
];

/** One-based ASCII roman numeral for display (I, II, III, IV, …). */
export function phaseRomanNumeral(oneBasedIndex: number): string {
	if (oneBasedIndex <= 0) return "";
	let out = "";
	let rem = oneBasedIndex;
	for (const [value, sym] of ROMAN_PAIRS) {
		while (rem >= value) {
			out += sym;
			rem -= value;
		}
	}
	return out;
}

/** Display-only phase header: `I. Foundation`. State and prompts never see this. */
export function formatPhaseDisplayName(
	name: string,
	oneBasedIndex: number,
): string {
	return `${phaseRomanNumeral(oneBasedIndex)}. ${forDisplay(name)}`;
}

// =============================================================================
// Strike-through helpers
// =============================================================================

export const TODO_STRIKE_HOLD_FRAMES = 2;
export const TODO_STRIKE_REVEAL_FRAMES = 12;
export const TODO_STRIKE_TOTAL_FRAMES =
	TODO_STRIKE_HOLD_FRAMES + TODO_STRIKE_REVEAL_FRAMES;
const EMPTY_COMPLETION_KEYS = new Set<string>();
const STRIKE_START = "\x1b[9m";
const STRIKE_END = "\x1b[29m";

function strikethroughText(text: string): string {
	return `${STRIKE_START}${text}${STRIKE_END}`;
}

function partialStrikethrough(text: string, visibleChars: number): string {
	if (visibleChars <= 0) return text;
	const chars = [...text];
	if (visibleChars >= chars.length) return strikethroughText(text);
	return `${strikethroughText(chars.slice(0, visibleChars).join(""))}${chars.slice(visibleChars).join("")}`;
}

/** Visible char count for a strike reveal at `frame`; undefined = full strike. */
export function strikeRevealCount(
	text: string,
	frame: number | undefined,
): number | undefined {
	if (frame === undefined) return undefined;
	if (frame <= TODO_STRIKE_HOLD_FRAMES) return 0;
	const chars = [...text];
	if (chars.length === 0) return undefined;
	const revealFrame = Math.min(
		frame - TODO_STRIKE_HOLD_FRAMES,
		TODO_STRIKE_REVEAL_FRAMES,
	);
	return Math.ceil((chars.length * revealFrame) / TODO_STRIKE_REVEAL_FRAMES);
}

function formatTodoLine(
	item: TodoItem,
	uiTheme: Theme,
	prefix: string,
	completionKeys: Set<string>,
	frame: number | undefined,
	matched = false,
): string {
	const label = forDisplay(item.content);
	switch (item.status) {
		case "completed": {
			const revealCount = completionKeys.has(item.content)
				? strikeRevealCount(label, frame)
				: undefined;
			const content =
				revealCount === undefined
					? strikethroughText(label)
					: partialStrikethrough(label, revealCount);
			return uiTheme.fg("success", `${prefix}✓ ${content}`);
		}
		case "in_progress":
			return uiTheme.fg("accent", `${prefix}○ ${label}`);
		case "abandoned":
			return uiTheme.fg("error", `${prefix}○ ${strikethroughText(label)}`);
		case "blocked": {
			const note = item.blocker
				? `blocked: ${forDisplay(item.blocker)}`
				: "blocked";
			return uiTheme.fg("warning", `${prefix}○ ${label} (${note})`);
		}
		default:
			return uiTheme.fg(matched ? "accent" : "dim", `${prefix}○ ${label}`);
	}
}

// =============================================================================
// Call/result arg normalization
// =============================================================================

type TodoRenderOp = {
	op?: string;
	task?: string;
	phase?: string;
	items?: string[];
};

/** New single-op shape `{op,...}`; legacy `{ops:[...]}` still seen in old transcripts. */
type TodoRenderArgs = TodoRenderOp & {
	ops?: TodoRenderOp[];
};

/**
 * Normalize streaming/legacy render args to a flat op list. Accepts the new
 * top-level `{op,...}` shape (returned as a one-element list), the legacy
 * `{ops:[...]}` batch from old transcripts, and partially-parsed streaming
 * deltas (non-array `ops`, non-object entries) without crashing.
 */
function normalizeTodoArg(args: TodoRenderArgs | undefined): TodoRenderOp[] {
	if (!args || typeof args !== "object") return [];
	if (Array.isArray(args.ops)) {
		return args.ops.filter(
			(entry): entry is TodoRenderOp =>
				entry != null && typeof entry === "object",
		);
	}
	return typeof args.op === "string" ? [args] : [];
}

/**
 * Phases the latest update touched, plus the active (in_progress) phase.
 * Returns `null` when there is no usable signal, meaning "render every phase
 * fully" — this preserves the legacy view and the manual-expand path.
 */
function computeTouchedPhases(
	args: TodoRenderArgs | undefined,
	phases: TodoPhase[],
	completedTasks: TodoCompletionTransition[],
): Set<string> | null {
	const touched = new Set<string>();
	for (const phase of phases) {
		if (phase.tasks.some((task) => task.status === "in_progress"))
			touched.add(phase.name);
	}
	for (const transition of completedTasks) touched.add(transition.phase);
	const ops = normalizeTodoArg(args);
	for (const op of ops) {
		if (!op || typeof op !== "object") continue;
		if (op.op === "init") {
			for (const phase of phases) touched.add(phase.name);
			break;
		}
		if (typeof op.phase === "string" && op.phase) {
			const named = phases.find((phase) => phase.name === op.phase);
			if (named) touched.add(named.name);
		}
		if (typeof op.task === "string" && op.task) {
			const located = phases.find((phase) =>
				phase.tasks.some((task) => task.content === op.task),
			);
			if (located) touched.add(located.name);
		}
	}
	return touched.size > 0 ? touched : null;
}

/**
 * Dim `closed/total` suffix for a phase header. Counts closed tasks, not just
 * completed ones: the collapsed viewport hides both, so an abandoned task has
 * to move the counter or its phase reads as permanently stuck.
 */
function formatPhaseProgress(phase: TodoPhase, uiTheme: Theme): string {
	const done = phase.tasks.filter(isClosedTodo).length;
	return uiTheme.fg("dim", `  ${done}/${phase.tasks.length}`);
}

/** One-line summary for a collapsed (untouched) phase: dim header + progress. */
function formatPhaseSummary(
	phase: TodoPhase,
	oneBasedIndex: number,
	uiTheme: Theme,
): string {
	const name = uiTheme.fg(
		"dim",
		uiTheme.bold(formatPhaseDisplayName(phase.name, oneBasedIndex)),
	);
	return `${name}${formatPhaseProgress(phase, uiTheme)}`;
}

function renderPhaseBody(
	phase: TodoPhase,
	oneBasedIndex: number,
	uiTheme: Theme,
	multiPhase: boolean,
	expanded: boolean,
	completionKeys: Set<string>,
	frame: number | undefined,
	isMatched: (task: TodoItem) => boolean,
): string[] {
	const lines: string[] = [];
	if (multiPhase) {
		const name = uiTheme.fg(
			"accent",
			uiTheme.bold(formatPhaseDisplayName(phase.name, oneBasedIndex)),
		);
		lines.push(`${name}${formatPhaseProgress(phase, uiTheme)}`);
	}
	if (expanded) {
		for (const task of phase.tasks) {
			lines.push(formatTodoLine(task, uiTheme, "", completionKeys, frame));
		}
		return lines;
	}
	const selection = selectCollapsedTodos(
		phase.tasks,
		isMatched,
		COLLAPSED_ITEMS_CAP,
	);
	for (const task of selection.items) {
		lines.push(
			formatTodoLine(task, uiTheme, "", completionKeys, frame, isMatched(task)),
		);
	}
	if (selection.summary) {
		lines.push(uiTheme.fg("dim", selection.summary));
	}
	return lines;
}

export interface TodoRenderCallArgs extends TodoRenderArgs {}

/** Render the streaming/preview line for a todo tool call. */
export function todoRenderCall(
	args: TodoRenderCallArgs | undefined,
	uiTheme: Theme,
): Component {
	const opsList = normalizeTodoArg(args);
	const ops =
		opsList.length === 0
			? ["update"]
			: opsList.map((e) => {
					const parts = [forDisplay(e.op ?? "update")];
					if (e.task) parts.push(forDisplay(e.task));
					if (e.phase) parts.push(forDisplay(e.phase));
					if (Array.isArray(e.items) && e.items.length) {
						parts.push(
							`${e.items.length} item${e.items.length === 1 ? "" : "s"}`,
						);
					}
					return parts.join(" ");
				});
	const title = uiTheme.fg("toolTitle", uiTheme.bold("Todo"));
	const meta = uiTheme.fg("muted", ops.join(" · "));
	return new Text(`${title}  ${meta}`, 0, 0);
}

export interface TodoRenderResultOptions {
	expanded: boolean;
	isPartial: boolean;
	/** Omp-compatible strike frame; pi passes no frame (completed = full strike). */
	spinnerFrame?: number;
}

/** Render a todo tool result (the full phase list with collapsed viewport). */
export function todoRenderResult(
	result: AgentToolResult<TodoToolDetails>,
	options: TodoRenderResultOptions,
	uiTheme: Theme,
	args?: TodoRenderArgs,
	isError = false,
): Component {
	if (isError) {
		const errorText =
			result.content?.find((content) => content.type === "text")?.text ??
			"Todo operation failed";
		return new Text(
			`${uiTheme.fg("error", uiTheme.bold("Todo"))}\n  ${uiTheme.fg("error", forDisplay(errorText))}`,
			0,
			0,
		);
	}

	const phases = (result.details?.phases ?? []).filter(
		(phase) => phase.tasks.length > 0,
	);
	const completedTasks = result.details?.completedTasks ?? [];
	const completionKeysByPhase = new Map<string, Set<string>>();
	for (const task of completedTasks) {
		let keys = completionKeysByPhase.get(task.phase);
		if (!keys) {
			keys = new Set<string>();
			completionKeysByPhase.set(task.phase, keys);
		}
		keys.add(task.content);
	}
	const allTasks = phases.flatMap((phase) => phase.tasks);
	const title = uiTheme.fg("toolTitle", uiTheme.bold("Todo"));
	const meta = uiTheme.fg("muted", `${allTasks.length} tasks`);
	const header = `${title}  ${meta}`;
	if (allTasks.length === 0) {
		const fallback = forDisplay(
			result.content?.find((content) => content.type === "text")?.text ??
				"No todos",
		);
		return new Text(`${header}\n  ${uiTheme.fg("dim", fallback)}`, 0, 0);
	}

	const { expanded } = options;
	const frame = options.spinnerFrame;
	const multiPhase = phases.length > 1;
	// Collapse phases this update didn't touch down to a one-line summary so
	// a single task flip doesn't redraw every phase's full task list. The
	// manual expand toggle (and the no-signal fallback) still shows all.
	const touched =
		expanded || !multiPhase
			? null
			: computeTouchedPhases(args, phases, completedTasks);
	const isMatched = (): boolean => false; // subagent matching is out of scope; literal in_progress still leads
	const bodyLines: string[] = [];
	for (let p = 0; p < phases.length; p++) {
		const phase = phases[p];
		if (phase === undefined) continue;
		if (touched && !touched.has(phase.name)) {
			bodyLines.push(formatPhaseSummary(phase, p + 1, uiTheme));
			continue;
		}
		const completionKeys =
			completionKeysByPhase.get(phase.name) ?? EMPTY_COMPLETION_KEYS;
		const indent = multiPhase ? "  " : "";
		for (const line of renderPhaseBody(
			phase,
			p + 1,
			uiTheme,
			multiPhase,
			expanded,
			completionKeys,
			frame,
			isMatched,
		)) {
			bodyLines.push(`${indent}${line}`);
		}
	}
	while (bodyLines.length > 0 && (bodyLines[0] ?? "").trim() === "")
		bodyLines.shift();
	return new Text([header, ...bodyLines].join("\n"), 0, 0);
}
