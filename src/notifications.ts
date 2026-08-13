/**
 * Pure derivation of desktop-notify requests from todo state transitions.
 *
 * The payloads identify the transition in the title and include the names of
 * tasks that crossed into the terminal state.
 */

import type { TodoItem, TodoPhase } from "./types.ts";

export interface TodoNotificationPayload {
	title: string;
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

function getNewTransitionNames(
	previous: TodoPhase[],
	next: TodoPhase[],
	target: "completed" | "blocked",
): string[] {
	const previousStatuses = new Map<string, TodoItem["status"]>();
	for (const phase of previous) {
		for (const task of phase.tasks) {
			previousStatuses.set(todoIdentity(phase.name, task.content), task.status);
		}
	}

	const names: string[] = [];
	for (const phase of next) {
		for (const task of phase.tasks) {
			if (task.status !== target) continue;
			const previousStatus = previousStatuses.get(
				todoIdentity(phase.name, task.content),
			);
			if (previousStatus !== undefined && isActiveStatus(previousStatus)) {
				names.push(task.content);
			}
		}
	}
	return names;
}

function createNotification(
	target: "completed" | "blocked",
	taskNames: string[],
): TodoNotificationPayload {
	const completed = target === "completed";
	return {
		title: completed ? "Todo completed" : "Todo blocked",
		body: `${completed ? "Completed" : "Blocked"}: ${taskNames.join(", ")}`,
		type: completed ? "todo-completed" : "todo-blocked",
		urgency: "normal",
		sound: completed ? "info" : "warning",
	};
}

/**
 * Derive EventBus payloads for newly completed and blocked tasks. Completion is
 * emitted before blocked when one mutation creates both groups.
 */
export function deriveTodoNotifications(
	previous: TodoPhase[],
	next: TodoPhase[],
): TodoNotificationPayload[] {
	const completed = getNewTransitionNames(previous, next, "completed");
	const blocked = getNewTransitionNames(previous, next, "blocked");
	const notifications: TodoNotificationPayload[] = [];
	if (completed.length > 0)
		notifications.push(createNotification("completed", completed));
	if (blocked.length > 0)
		notifications.push(createNotification("blocked", blocked));
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
