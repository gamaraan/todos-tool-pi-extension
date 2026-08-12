/**
 * Todo extension configuration.
 *
 * The extension cannot extend pi's built-in Settings schema, so it follows
 * the same host-config pattern as `@gamaraan/next-prompt`: a small JSON file
 * in the host agent dir (global) optionally overridden per project.
 *
 *   Pi global:  ~/.pi/agent/todo.json
 *   Pi project: <cwd>/.pi/todo.json   (only when the project is trusted)
 *
 * ```json
 * { "enabled": true, "reminders": true, "remindersMax": 3, "eager": "default" }
 * ```
 *
 * All keys optional; invalid values fall back to defaults. Project config can
 * never disable a global `enabled: false` (fail closed).
 */

import * as fs from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export type TodoEagerMode = "default" | "preferred" | "always";

export interface TodoConfig {
	/** Gates the todo tool's availability and every tracker behavior. */
	enabled: boolean;
	/** Stop-time incomplete-todo reminders. */
	reminders: boolean;
	/** Max reminder attempts per prompt cycle. */
	remindersMax: number;
	/** First-turn eager prelude mode. */
	eager: TodoEagerMode;
}

export const TODO_CONFIG_DEFAULTS: TodoConfig = {
	enabled: true,
	reminders: true,
	remindersMax: 3,
	eager: "default",
};

export interface LoadedTodoConfig {
	config: TodoConfig;
	/** The project config file was honored (trusted project). */
	projectTrusted: boolean;
}

function parseConfigFile(
	filePath: string,
	warn: (message: string) => void,
): Partial<TodoConfig> | undefined {
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf8");
	} catch {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		warn(
			`todos: invalid JSON in ${filePath}; using defaults (${error instanceof Error ? error.message : String(error)})`,
		);
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		warn(`todos: config ${filePath} is not an object; using defaults`);
		return undefined;
	}

	const record = parsed as Record<string, unknown>;
	const out: Partial<TodoConfig> = {};
	if (record.enabled !== undefined) {
		if (typeof record.enabled === "boolean") out.enabled = record.enabled;
		else warn(`todos: invalid enabled in ${filePath}; ignoring`);
	}
	if (record.reminders !== undefined) {
		if (typeof record.reminders === "boolean") out.reminders = record.reminders;
		else warn(`todos: invalid reminders in ${filePath}; ignoring`);
	}
	if (record.remindersMax !== undefined) {
		if (
			typeof record.remindersMax === "number" &&
			Number.isInteger(record.remindersMax) &&
			record.remindersMax >= 0
		) {
			out.remindersMax = record.remindersMax;
		} else warn(`todos: invalid remindersMax in ${filePath}; ignoring`);
	}
	if (record.eager !== undefined) {
		if (
			record.eager === "default" ||
			record.eager === "preferred" ||
			record.eager === "always"
		) {
			out.eager = record.eager;
		} else warn(`todos: invalid eager in ${filePath}; ignoring`);
	}
	for (const key of Object.keys(record)) {
		if (
			key !== "enabled" &&
			key !== "reminders" &&
			key !== "remindersMax" &&
			key !== "eager"
		) {
			warn(`todos: unknown config key "${key}" in ${filePath} ignored`);
		}
	}
	return out;
}

/**
 * Load and merge the global + (trusted) project config.
 *
 * A global `enabled: false` is a floor: project config can re-enable other
 * knobs but never the tool itself. Project config is only honored when
 * `isProjectTrusted()` says the project is trusted.
 */
export function loadTodoConfig(
	cwd: string,
	isProjectTrusted: () => boolean,
	warn: (message: string) => void,
): LoadedTodoConfig {
	const globalFile = join(getAgentDir(), "todo.json");
	const globalPartial = parseConfigFile(globalFile, warn) ?? {};
	const config: TodoConfig = { ...TODO_CONFIG_DEFAULTS, ...globalPartial };

	let projectTrusted = false;
	if (isProjectTrusted()) {
		const projectFile = join(cwd, CONFIG_DIR_NAME, "todo.json");
		const projectPartial = parseConfigFile(projectFile, warn);
		if (projectPartial) {
			projectTrusted = true;
			config.enabled = config.enabled && (projectPartial.enabled ?? true);
			config.reminders = projectPartial.reminders ?? config.reminders;
			config.remindersMax = projectPartial.remindersMax ?? config.remindersMax;
			config.eager = projectPartial.eager ?? config.eager;
		}
	}

	return { config, projectTrusted };
}
