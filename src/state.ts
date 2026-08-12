/**
 * Pure todo state operations — no I/O, no session access.
 *
 * Ported from Oh My Pi's `packages/coding-agent/src/tools/todo.ts`
 * (state helpers section).
 */

import { Value } from "typebox/value";
import {
	todoSchema,
	type TodoCompletionTransition,
	type TodoItem,
	type TodoOperation,
	type TodoParams,
	type TodoPhase,
} from "./types.ts";

export const TODO_DESCRIPTION_MIN_OVERLAP = 6;
/** Cap for collapsed per-phase todo previews (omp `PREVIEW_LIMITS.COLLAPSED_ITEMS`). */
export const COLLAPSED_ITEMS_CAP = 8;

function findTaskByContent(
	phases: TodoPhase[],
	content: string,
): { task: TodoItem; phase: TodoPhase } | undefined {
	for (const phase of phases) {
		const task = phase.tasks.find((t) => t.content === content);
		if (task) return { task, phase };
	}
	return undefined;
}

function findPhaseByName(
	phases: TodoPhase[],
	name: string,
): TodoPhase | undefined {
	return phases.find((phase) => phase.name === name);
}

export function cloneTask(task: TodoItem): TodoItem {
	return task.blocker !== undefined
		? { content: task.content, status: task.status, blocker: task.blocker }
		: { content: task.content, status: task.status };
}

export function clonePhases(phases: TodoPhase[]): TodoPhase[] {
	return phases.map((phase) => ({
		name: phase.name,
		tasks: phase.tasks.map(cloneTask),
	}));
}

function todoTransitionKey(phase: string, content: string): string {
	return `${phase}\u0000${content}`;
}

export function getCompletionTransitions(
	previous: TodoPhase[],
	updated: TodoPhase[],
): TodoCompletionTransition[] {
	const previousStatuses = new Map<string, TodoItem["status"]>();
	for (const phase of previous) {
		for (const task of phase.tasks) {
			previousStatuses.set(
				todoTransitionKey(phase.name, task.content),
				task.status,
			);
		}
	}

	const transitions: TodoCompletionTransition[] = [];
	for (const phase of updated) {
		for (const task of phase.tasks) {
			if (task.status !== "completed") continue;
			const previousStatus = previousStatuses.get(
				todoTransitionKey(phase.name, task.content),
			);
			if (previousStatus && previousStatus !== "completed") {
				transitions.push({ phase: phase.name, content: task.content });
			}
		}
	}
	return transitions;
}

export function normalizeInProgressTask(phases: TodoPhase[]): void {
	const orderedTasks = phases.flatMap((phase) => phase.tasks);
	if (orderedTasks.length === 0) return;

	const inProgressTasks = orderedTasks.filter(
		(task) => task.status === "in_progress",
	);
	if (inProgressTasks.length > 1) {
		for (const task of inProgressTasks.slice(1)) {
			task.status = "pending";
		}
	}

	if (inProgressTasks.length > 0) return;

	const firstPendingTask = orderedTasks.find(
		(task) => task.status === "pending",
	);
	if (firstPendingTask) firstPendingTask.status = "in_progress";
}

/** Return the active todo task, preferring an in-progress item over the first pending item. */
export function nextActionableTask(
	phases: readonly TodoPhase[],
): TodoItem | undefined {
	let firstPending: TodoItem | undefined;
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.status === "in_progress") return task;
			if (!firstPending && task.status === "pending") firstPending = task;
		}
	}
	return firstPending;
}

/** Whether an unknown value is a persisted todo phase. */
export function isTodoPhase(value: unknown): value is TodoPhase {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	if (typeof record.name !== "string" || !Array.isArray(record.tasks))
		return false;
	return record.tasks.every(
		(task) =>
			typeof task === "object" &&
			task !== null &&
			typeof (task as Record<string, unknown>).content === "string" &&
			((task as Record<string, unknown>).status === "pending" ||
				(task as Record<string, unknown>).status === "in_progress" ||
				(task as Record<string, unknown>).status === "completed" ||
				(task as Record<string, unknown>).status === "abandoned" ||
				(task as Record<string, unknown>).status === "blocked"),
	);
}

/**
 * Normalize-then-match helper: lowercases and collapses punctuation and
 * whitespace runs to single spaces.
 */
export function normalizeForTodoMatch(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

/**
 * Report whether `content` likely names the same work as any entry in
 * `descriptions`. Matching is normalize-then-equal first, with a substring
 * fallback in either direction so minor wording drift still links up. The
 * substring fallback requires at least {@link TODO_DESCRIPTION_MIN_OVERLAP}
 * chars on the contained side. (Used by the HUD to light up pending todos
 * whose work is in flight; without subagents the only match source is
 * literal `in_progress` tasks, so this is mostly inert.)
 */
export function todoMatchesAnyDescription(
	content: string,
	descriptions: readonly string[],
): boolean {
	const target = normalizeForTodoMatch(content);
	if (!target) return false;
	for (const desc of descriptions) {
		const candidate = normalizeForTodoMatch(desc);
		if (!candidate) continue;
		if (target === candidate) return true;
		if (
			target.length >= TODO_DESCRIPTION_MIN_OVERLAP &&
			candidate.includes(target)
		)
			return true;
		if (
			candidate.length >= TODO_DESCRIPTION_MIN_OVERLAP &&
			target.includes(candidate)
		)
			return true;
	}
	return false;
}

/** Whether a todo is settled: completed or deliberately abandoned. */
export function isClosedTodo<T extends { status: TodoItem["status"] }>(
	task: T,
): boolean {
	return task.status === "completed" || task.status === "abandoned";
}

function pluralize(word: string, count: number): string {
	if (count === 1) return word;
	if (/(?:ch|sh|s|x|z)$/i.test(word)) return `${word}es`;
	if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
	return `${word}s`;
}

function formatMoreItems(remaining: number, itemType: string): string {
	const safeRemaining = Number.isFinite(remaining) ? remaining : 0;
	return `… ${safeRemaining} more ${pluralize(itemType, safeRemaining)}`;
}

/**
 * A todo the collapsed viewport treats as current work: the literal
 * `in_progress` task or a pending task matched by `isMatched` (in omp, a
 * live subagent is executing it).
 */
function isActiveTodo<T extends { status: TodoItem["status"] }>(
	task: T,
	isMatched: (task: T) => boolean,
): boolean {
	return (
		task.status === "in_progress" ||
		(task.status === "pending" && isMatched(task))
	);
}

export interface CollapsedTodoSelection<T> {
	items: T[];
	summary: string;
}

/** Closed rows kept directly above the open window so finishing a task is visible as it happens. */
const COLLAPSED_CLOSED_CONTEXT = 1;

/**
 * Rows to show for a display base already reduced to the relevant tasks.
 * Every active task is placed at the head in stable todo order; remaining
 * rows up to `cap` are filled with the pending tasks that follow the first
 * active one. When active tasks alone exceed `cap`, only the first `cap`
 * active tasks are shown and the summary counts the hidden *active* todos.
 */
function selectWithinCap<T extends { status: TodoItem["status"] }>(
	base: T[],
	isMatched: (task: T) => boolean,
	cap: number,
): CollapsedTodoSelection<T> {
	if (base.length <= cap) return { items: base, summary: "" };

	const active = base.filter((task) => isActiveTodo(task, isMatched));
	if (active.length > cap) {
		const hiddenActive = active.length - cap;
		return {
			items: active.slice(0, cap),
			summary: `… ${hiddenActive} more active ${pluralize("todo", hiddenActive)}`,
		};
	}

	const firstActive = active[0];
	const firstActiveIdx =
		firstActive !== undefined ? base.indexOf(firstActive) : 0;
	const fill: T[] = [];
	for (
		let i = firstActiveIdx;
		i < base.length && active.length + fill.length < cap;
		i++
	) {
		const task = base[i];
		if (task === undefined) continue;
		if (isActiveTodo(task, isMatched)) continue;
		fill.push(task);
	}
	const items = [...active, ...fill];
	const hidden = base.length - items.length;
	return { items, summary: hidden > 0 ? formatMoreItems(hidden, "todo") : "" };
}

/**
 * Walking-viewport selection for a phase's collapsed todo preview: the open
 * tasks run through {@link selectWithinCap}, led by the last
 * {@link COLLAPSED_CLOSED_CONTEXT} closed tasks in todo order so a checked
 * row remains visible even when callers complete work out of sequence. A
 * phase with no open work left falls back to its closed tasks.
 */
export function selectCollapsedTodos<T extends { status: TodoItem["status"] }>(
	tasks: T[],
	isMatched: (task: T) => boolean,
	cap: number,
): CollapsedTodoSelection<T> {
	const open = tasks.filter((task) => !isClosedTodo(task));
	if (open.length === 0) return selectWithinCap(tasks, isMatched, cap);
	const lead = tasks.filter(isClosedTodo).slice(-COLLAPSED_CLOSED_CONTEXT);
	const selected = selectWithinCap(open, isMatched, cap);
	return { items: [...lead, ...selected.items], summary: selected.summary };
}

function resolveTaskOrError(
	phases: TodoPhase[],
	content: string | undefined,
	errors: string[],
): { task: TodoItem; phase: TodoPhase } | undefined {
	if (!content) {
		errors.push("Missing task content");
		return undefined;
	}
	const hit = findTaskByContent(phases, content);
	if (!hit) {
		if (/^task-\d+$/.test(content)) {
			errors.push(
				`Task "${content}" not found. Tasks are referenced by content, not by IDs — pass the task's full text from the previous result.`,
			);
		} else {
			const totalTasks = phases.reduce(
				(sum, phase) => sum + phase.tasks.length,
				0,
			);
			const hint =
				totalTasks === 0
					? " (todo list is empty — was it replaced or not yet created?)"
					: "";
			errors.push(`Task "${content}" not found${hint}`);
		}
	}
	return hit;
}

function resolvePhaseOrError(
	phases: TodoPhase[],
	name: string | undefined,
	errors: string[],
): TodoPhase | undefined {
	if (!name) {
		errors.push("Missing phase name");
		return undefined;
	}
	const phase = findPhaseByName(phases, name);
	if (!phase) errors.push(`Phase "${name}" not found`);
	return phase;
}

function getTaskTargets(
	phases: TodoPhase[],
	entry: TodoParams,
	errors: string[],
): TodoItem[] {
	if (entry.task) {
		const hit = resolveTaskOrError(phases, entry.task, errors);
		return hit ? [hit.task] : [];
	}
	if (entry.phase) {
		const phase = resolvePhaseOrError(phases, entry.phase, errors);
		return phase ? [...phase.tasks] : [];
	}
	return phases.flatMap((phase) => phase.tasks);
}

/** Phase name for `init` given a flat `items` list with no explicit `phase`. */
const DEFAULT_INIT_PHASE = "Tasks";

function initPhases(entry: TodoParams, errors: string[]): TodoPhase[] {
	// Models routinely flatten the single-phase init into `{op:"init", items:[...]}`
	// (optionally with a bare `phase`) instead of the canonical
	// `list: [{phase, items}]`. Accept that shape by synthesizing a one-phase list
	// so a common, recoverable mistake isn't a hard error.
	const list =
		entry.list ??
		(entry.items && entry.items.length > 0
			? [{ phase: entry.phase ?? DEFAULT_INIT_PHASE, items: entry.items }]
			: undefined);
	if (!list) {
		errors.push("Missing list for init operation");
		return [];
	}
	// Duplicate phase names / task contents would be permanently unaddressable
	// (every targeting op resolves the first match), so reject them up front.
	const seenPhases = new Set<string>();
	const seenTasks = new Set<string>();
	for (const listEntry of list) {
		if (seenPhases.has(listEntry.phase)) {
			errors.push(`Duplicate phase "${listEntry.phase}" in init list`);
		}
		seenPhases.add(listEntry.phase);
		for (const content of listEntry.items) {
			if (seenTasks.has(content)) {
				errors.push(`Duplicate task "${content}" in init list`);
			}
			seenTasks.add(content);
		}
	}
	return list.map((listEntry) => ({
		name: listEntry.phase,
		tasks: listEntry.items.map<TodoItem>((content) => ({
			content,
			status: "pending",
		})),
	}));
}

function appendItems(
	phases: TodoPhase[],
	entry: TodoParams,
	errors: string[],
): TodoPhase[] {
	if (!entry.phase) {
		errors.push("Missing phase name for append operation");
		return phases;
	}
	if (!entry.items || entry.items.length === 0) {
		errors.push("Missing items for append operation");
		return phases;
	}

	// Validate the whole batch before mutating so a failing op reports every
	// duplicate and leaves nothing half-applied.
	const seen = new Set<string>();
	let hasDuplicate = false;
	for (const content of entry.items) {
		if (seen.has(content) || findTaskByContent(phases, content)) {
			errors.push(`Task "${content}" already exists`);
			hasDuplicate = true;
		}
		seen.add(content);
	}
	if (hasDuplicate) return phases;

	let phase = findPhaseByName(phases, entry.phase);
	if (!phase) {
		phase = { name: entry.phase, tasks: [] };
		phases.push(phase);
	}

	for (const content of entry.items) {
		phase.tasks.push({ content, status: "pending" });
	}
	return phases;
}

function removeTasks(
	phases: TodoPhase[],
	entry: TodoParams,
	errors: string[],
): TodoPhase[] {
	if (entry.task) {
		const hit = resolveTaskOrError(phases, entry.task, errors);
		if (!hit) return phases;
		hit.phase.tasks = hit.phase.tasks.filter(
			(candidate) => candidate !== hit.task,
		);
		return phases;
	}
	if (entry.phase) {
		const phase = resolvePhaseOrError(phases, entry.phase, errors);
		if (!phase) return phases;
		phase.tasks = [];
		return phases;
	}
	for (const phase of phases) {
		phase.tasks = [];
	}
	return phases;
}

function applyEntry(
	phases: TodoPhase[],
	entry: TodoParams,
	errors: string[],
): TodoPhase[] {
	switch (entry.op) {
		case "init":
			return initPhases(entry, errors);
		case "start": {
			const hit = resolveTaskOrError(phases, entry.task, errors);
			if (!hit) return phases;
			for (const phase of phases) {
				for (const candidate of phase.tasks) {
					if (candidate.status === "in_progress" && candidate !== hit.task) {
						candidate.status = "pending";
					}
				}
			}
			hit.task.status = "in_progress";
			return phases;
		}
		case "done": {
			for (const task of getTaskTargets(phases, entry, errors)) {
				task.status = "completed";
			}
			return phases;
		}
		case "drop": {
			for (const task of getTaskTargets(phases, entry, errors)) {
				task.status = "abandoned";
			}
			return phases;
		}
		case "block": {
			if (!entry.task && !entry.phase) {
				errors.push("block requires a task or phase target");
				return phases;
			}
			// Collapse whitespace runs (incl. newlines) to single spaces: a blocker
			// note rides on one Markdown checklist line (as a trailing HTML comment)
			// and one HUD/summary line, so an embedded newline from a multi-line
			// external error or user question would corrupt the round-trip parse and
			// the rendered line. Normalizing here keeps every consumer one-line-safe.
			const reason = entry.reason?.replace(/\s+/g, " ").trim() || undefined;
			for (const task of getTaskTargets(phases, entry, errors)) {
				// Only actionable open work can be blocked: blocking a phase must not
				// reopen completed/abandoned tasks or erase finished progress. An
				// already-blocked task stays eligible so a later block can refine its
				// blocker note (e.g. first blocked without a reason, then with one).
				if (
					task.status !== "pending" &&
					task.status !== "in_progress" &&
					task.status !== "blocked"
				)
					continue;
				task.status = "blocked";
				task.blocker = reason;
			}
			return phases;
		}
		case "unblock": {
			if (!entry.task && !entry.phase) {
				errors.push("unblock requires a task or phase target");
				return phases;
			}
			for (const task of getTaskTargets(phases, entry, errors)) {
				if (task.status === "blocked") {
					task.status = "pending";
					task.blocker = undefined;
				}
			}
			return phases;
		}
		case "rm":
			return removeTasks(phases, entry, errors);
		case "append":
			return appendItems(phases, entry, errors);
		case "view":
			return phases;
	}
}

/**
 * Infer a missing `op` from the raw argument shape. Only unambiguous shapes
 * are inferred:
 * - `list` → `init` (list is init-only)
 * - `items` + `phase` → `append` (lazily creates the phase, so the result
 *   matches a single-phase init when nothing exists yet)
 * - bare `items` with no existing todos → `init` (nothing to overwrite)
 * Targeting args alone (`task`/`phase`) map to several ops and stay an error.
 */
export function inferTodoOp(
	args: Record<string, unknown>,
	hasExistingPhases: boolean,
): TodoOperation | undefined {
	if (Array.isArray(args.list) && args.list.length > 0) return "init";
	if (Array.isArray(args.items) && args.items.length > 0) {
		if (typeof args.phase === "string" && args.phase) return "append";
		if (!hasExistingPhases) return "init";
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate execute-time arguments, repairing an omitted `op`. The tool's
 * `prepareArguments` shim repairs a missing `op` alongside an unambiguous
 * payload (models routinely send `{list:[...]}` with no op) before schema
 * validation; this re-validates at execute time as defense in depth.
 * Anything else returns the schema error text for a normal model retry.
 */
export function resolveTodoParams(
	raw: unknown,
	hasExistingPhases: boolean,
): TodoParams | string {
	if (Value.Check(todoSchema, raw)) return raw as TodoParams;
	if (isRecord(raw) && raw.op === undefined) {
		const inferred = inferTodoOp(raw, hasExistingPhases);
		if (inferred) {
			const repaired = { ...raw, op: inferred };
			if (Value.Check(todoSchema, repaired)) return repaired as TodoParams;
		}
	}
	const summary = Value.Errors(todoSchema, raw)
		.map((error) => `${error.instancePath || "(root)"}: ${error.message}`)
		.join("; ");
	return `Invalid todo arguments: ${summary}`;
}

export function applyParams(
	phases: TodoPhase[],
	params: TodoParams,
): { phases: TodoPhase[]; errors: string[] } {
	const errors: string[] = [];
	const next = applyEntry(phases, params, errors);
	normalizeInProgressTask(next);
	return { phases: next, errors };
}

/** Apply an array of `todo`-style ops to existing phases. Used by /todo slash command. */
export function applyOpsToPhases(
	currentPhases: TodoPhase[],
	ops: TodoParams[],
): { phases: TodoPhase[]; errors: string[] } {
	const errors: string[] = [];
	let next = clonePhases(currentPhases);
	for (const op of ops) {
		next = applyEntry(next, op, errors);
	}
	normalizeInProgressTask(next);
	return { phases: next, errors };
}
