/**
 * Pure derivation of desktop-notify requests from todo state transitions.
 *
 * The payloads intentionally contain counts only. Task text and blocker
 * reasons never leave the todo extension through this integration boundary.
 */

import type { TodoItem, TodoPhase } from "./types.ts";

export interface TodoNotificationPayload {
	title: "Todo";
	body: string;
	type: "todo-completed" | "todo-blocked";
	urgency: "normal";
	sound: "info" | "warning";
}

function todoIdentity(phaseName: string, content: string): string {
	return `${phaseName}\u0000${content}`;
}

function isActiveStatus(status: TodoItem["status"]): boolean {
	return status === "pending" || status === "in_progress";
}

function countNewTransitions(
	previous: TodoPhase[],
	next: TodoPhase[],
	target: "completed" | "blocked",
): number {
	const previousStatuses = new Map<string, TodoItem["status"]>();
	for (const phase of previous) {
		for (const task of phase.tasks) {
			previousStatuses.set(todoIdentity(phase.name, task.content), task.status);
		}
	}

	let count = 0;
	for (const phase of next) {
		for (const task of phase.tasks) {
			if (task.status !== target) continue;
			const previousStatus = previousStatuses.get(
				todoIdentity(phase.name, task.content),
			);
			if (previousStatus !== undefined && isActiveStatus(previousStatus)) {
				count++;
			}
		}
	}
	return count;
}

/**
 * Derive bounded EventBus payloads for newly completed and blocked tasks.
 * Completion is emitted before blocked when one mutation creates both groups.
 */
export function deriveTodoNotifications(
	previous: TodoPhase[],
	next: TodoPhase[],
): TodoNotificationPayload[] {
	const completed = countNewTransitions(previous, next, "completed");
	const blocked = countNewTransitions(previous, next, "blocked");
	const notifications: TodoNotificationPayload[] = [];
	if (completed > 0) {
		notifications.push({
			title: "Todo",
			body: `Completed ${completed} todo task${completed === 1 ? "" : "s"}`,
			type: "todo-completed",
			urgency: "normal",
			sound: "info",
		});
	}
	if (blocked > 0) {
		notifications.push({
			title: "Todo",
			body: `Blocked ${blocked} todo task${blocked === 1 ? "" : "s"}`,
			type: "todo-blocked",
			urgency: "normal",
			sound: "warning",
		});
	}
	return notifications;
}

/**
 * Match ask-tool's terminal capability gate. OSC 9/99 terminals can decide
 * whether the terminal/tab is unfocused; generic native fallbacks cannot.
 */
export function supportsTodoTerminalNotifications(
	env: Readonly<Record<string, string | undefined>>,
): boolean {
	const program = env.TERM_PROGRAM?.trim().toLowerCase() ?? "";
	const term = env.TERM?.trim().toLowerCase() ?? "";
	return (
		program === "kitty" ||
		term === "xterm-kitty" ||
		Boolean(env.KITTY_WINDOW_ID) ||
		program === "ghostty" ||
		Boolean(env.GHOSTTY_RESOURCES_DIR) ||
		program === "wezterm" ||
		Boolean(env.WEZTERM_PANE) ||
		program === "iterm.app" ||
		program === "iterm2" ||
		Boolean(env.ITERM_SESSION_ID) ||
		env.LC_TERMINAL?.trim().toLowerCase() === "iterm2" ||
		program === "warpterminal" ||
		program === "warp" ||
		term.includes("ghostty")
	);
}
