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
import { dirname, join } from "node:path";
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

export const TODO_CONFIG_FILE_NAME = "todo.json";
export const TODO_FLAGS = {
	enabled: "todo-enabled",
	reminders: "todo-reminders",
	remindersMax: "todo-reminders-max",
	eager: "todo-eager",
} as const;
export const TODO_ENV = {
	enabled: "PI_TODO_ENABLED",
	reminders: "PI_TODO_REMINDERS",
	remindersMax: "PI_TODO_REMINDERS_MAX",
	eager: "PI_TODO_EAGER",
} as const;

export interface TodoConfigOverrides {
	enabled?: boolean;
	reminders?: boolean;
	remindersMax?: number;
	eager?: TodoEagerMode;
}

export interface LoadedTodoConfig {
	config: TodoConfig;
	/** The project config file was honored (trusted project). */
	projectTrusted: boolean;
}

export function getTodoConfigPath(): string {
	return join(getAgentDir(), TODO_CONFIG_FILE_NAME);
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
	overrides: TodoConfigOverrides = {},
): LoadedTodoConfig {
	const globalFile = getTodoConfigPath();
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

	const effective: TodoConfig = { ...config };
	if (overrides.enabled !== undefined)
		effective.enabled =
			globalPartial.enabled === false ? false : overrides.enabled;
	if (overrides.reminders !== undefined)
		effective.reminders = overrides.reminders;
	if (overrides.remindersMax !== undefined)
		effective.remindersMax = overrides.remindersMax;
	if (overrides.eager !== undefined) effective.eager = overrides.eager;
	return { config: effective, projectTrusted };
}

function parseBooleanOverride(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	if (normalized === "on" || normalized === "true" || normalized === "1")
		return true;
	if (normalized === "off" || normalized === "false" || normalized === "0")
		return false;
	return undefined;
}

function parseRemindersMaxOverride(value: unknown): number | undefined {
	if (typeof value !== "string" && typeof value !== "number") return undefined;
	const parsed = typeof value === "number" ? value : Number(value.trim());
	return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseEagerOverride(value: unknown): TodoEagerMode | undefined {
	return value === "default" || value === "preferred" || value === "always"
		? value
		: undefined;
}

/** Resolve startup overrides with flag > environment > JSON precedence. */
export function resolveTodoConfig(
	cwd: string,
	isProjectTrusted: () => boolean,
	warn: (message: string) => void,
	getFlag: (name: string) => boolean | string | undefined,
	env: Readonly<Record<string, string | undefined>> = process.env,
): LoadedTodoConfig {
	const flagOrEnv = (flag: string, envName: string): unknown => {
		const fromFlag = getFlag(flag);
		return fromFlag !== undefined ? fromFlag : env[envName];
	};
	return loadTodoConfig(cwd, isProjectTrusted, warn, {
		enabled: parseBooleanOverride(
			flagOrEnv(TODO_FLAGS.enabled, TODO_ENV.enabled),
		),
		reminders: parseBooleanOverride(
			flagOrEnv(TODO_FLAGS.reminders, TODO_ENV.reminders),
		),
		remindersMax: parseRemindersMaxOverride(
			flagOrEnv(TODO_FLAGS.remindersMax, TODO_ENV.remindersMax),
		),
		eager: parseEagerOverride(flagOrEnv(TODO_FLAGS.eager, TODO_ENV.eager)),
	});
}

/** Read the persisted global config without applying project or runtime overrides. */
export function readTodoConfig(
	path = getTodoConfigPath(),
): Partial<TodoConfig> {
	return parseConfigFile(path, () => {}) ?? {};
}

/** Persist the complete global config used by the interactive wizard. */
export function saveTodoConfig(
	config: TodoConfig,
	path = getTodoConfigPath(),
): void {
	fs.mkdirSync(dirname(path), { recursive: true });
	if (fs.existsSync(path) && fs.lstatSync(path).isSymbolicLink()) {
		throw new Error(`refusing to overwrite symlink ${path}`);
	}
	const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
	try {
		fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, "utf8");
		fs.renameSync(temporary, path);
	} finally {
		if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
	}
}
