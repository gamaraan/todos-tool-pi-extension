/**
 * Text summary returned to the model after every todo operation.
 *
 * Ported from Oh My Pi's `packages/coding-agent/src/tools/todo.ts`
 * (`formatSummary`).
 */

import type { TodoPhase } from "./types.ts";

export function formatSummary(
	phases: TodoPhase[],
	errors: string[],
	readOnly = false,
): string {
	const tasks = phases.flatMap((phase) => phase.tasks);
	if (tasks.length === 0) {
		if (errors.length > 0) return `Errors: ${errors.join("; ")}`;
		return readOnly ? "Todo list is empty." : "Todo list cleared.";
	}

	const remainingByPhase = phases
		.map((phase) => ({
			name: phase.name,
			tasks: phase.tasks.filter(
				(task) => task.status === "pending" || task.status === "in_progress",
			),
		}))
		.filter((phase) => phase.tasks.length > 0);
	const remainingTasks = remainingByPhase.flatMap((phase) =>
		phase.tasks.map((task) => ({ ...task, phase: phase.name })),
	);

	let currentIdx = phases.findIndex((phase) =>
		phase.tasks.some(
			(task) => task.status === "pending" || task.status === "in_progress",
		),
	);
	if (currentIdx === -1) currentIdx = phases.length - 1;
	const current = phases[currentIdx];
	if (current === undefined)
		return errors.length > 0 ? `Errors: ${errors.join("; ")}` : "";
	const done = current.tasks.filter(
		(task) => task.status === "completed" || task.status === "abandoned",
	).length;

	const lines: string[] = [];
	if (errors.length > 0) lines.push(`Errors: ${errors.join("; ")}`);
	if (remainingTasks.length === 0) {
		lines.push("Remaining items: none.");
	} else {
		lines.push(`Remaining items (${remainingTasks.length}):`);
		for (const task of remainingTasks) {
			lines.push(`  - ${task.content} [${task.status}] (${task.phase})`);
		}
	}
	// Closed = completed + abandoned, mirroring the per-phase `done` count.
	const closedAll = tasks.filter(
		(task) => task.status === "completed" || task.status === "abandoned",
	).length;
	const blockedAll = tasks.filter((task) => task.status === "blocked").length;
	// The active phase is the EARLIEST one still holding open work, so the
	// in-progress pointer can sit in a phase whose successors already have
	// completed tasks. Detect that "worked ahead" case to explain the
	// otherwise-surprising backward pointer instead of letting it read as a
	// completed task reverting to pending.
	const workedAhead = phases.some(
		(phase, idx) =>
			idx > currentIdx &&
			phase.tasks.some(
				(task) => task.status === "completed" || task.status === "abandoned",
			),
	);
	lines.push(
		`Overall: ${closedAll}/${tasks.length} done, ${remainingTasks.length} open${blockedAll > 0 ? `, ${blockedAll} blocked` : ""}.`,
	);
	lines.push(
		`Active phase ${currentIdx + 1}/${phases.length} "${current.name}" (${done}/${current.tasks.length})${
			workedAhead
				? " — earliest phase with open tasks; the in-progress pointer auto-advances to the earliest open task on each completion, so it can sit behind out-of-order work (nothing was un-completed)."
				: "."
		}`,
	);
	for (const phase of phases) {
		lines.push(`  ${phase.name}:`);
		for (const task of phase.tasks) {
			const checkbox = task.status === "completed" ? "[X]" : "[ ]";
			const tag =
				task.status === "in_progress"
					? " (in progress)"
					: task.status === "abandoned"
						? " (dropped)"
						: task.status === "blocked"
							? task.blocker
								? ` (blocked: ${task.blocker})`
								: " (blocked)"
							: "";
			lines.push(`    - ${checkbox} ${task.content}${tag}`);
		}
	}
	return lines.join("\n");
}
