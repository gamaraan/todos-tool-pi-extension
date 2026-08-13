/**
 * Config loading: global + project merge, validation, trust gating.
 */

import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	loadTodoConfig,
	readTodoConfig,
	resolveTodoConfig,
	saveTodoConfig,
	TODO_CONFIG_DEFAULTS,
	TODO_FLAGS,
} from "../src/config.ts";

describe("loadTodoConfig", () => {
	const warnings: string[] = [];
	const warn = (message: string) => warnings.push(message);
	let tempRoot = "";
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

	afterEach(() => {
		if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
		tempRoot = "";
		warnings.length = 0;
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	});

	// Redirect the host agent dir (getAgentDir honors PI_CODING_AGENT_DIR)
	// into a sandbox so global-config tests never touch the real ~/.pi.
	function setupDirs(
		globalConfig: string | null,
		projectConfig: string | null,
	): { cwd: string } {
		tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "todos-config-"));
		const agent = path.join(tempRoot, "agent");
		fs.mkdirSync(agent, { recursive: true });
		if (globalConfig !== null)
			fs.writeFileSync(path.join(agent, "todo.json"), globalConfig, "utf8");
		process.env.PI_CODING_AGENT_DIR = agent;
		const cwd = path.join(tempRoot, "project");
		fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		if (projectConfig !== null)
			fs.writeFileSync(
				path.join(cwd, ".pi", "todo.json"),
				projectConfig,
				"utf8",
			);
		return { cwd };
	}

	it("returns defaults with no config files", () => {
		const { cwd } = setupDirs(null, null);
		const loaded = loadTodoConfig(cwd, () => true, warn);
		expect(loaded.config).toEqual(TODO_CONFIG_DEFAULTS);
		expect(loaded.projectTrusted).toBe(false);
	});

	it("loads the global config", () => {
		const { cwd } = setupDirs(
			JSON.stringify({ reminders: false, eager: "always" }),
			null,
		);
		const loaded = loadTodoConfig(cwd, () => true, warn);
		expect(loaded.config.reminders).toBe(false);
		expect(loaded.config.eager).toBe("always");
		expect(loaded.config.enabled).toBe(true);
		expect(loaded.config.remindersMax).toBe(3);
	});

	it("applies the project config only for trusted projects", () => {
		const { cwd } = setupDirs(
			null,
			JSON.stringify({ remindersMax: 5, eager: "preferred" }),
		);
		const trusted = loadTodoConfig(cwd, () => true, warn);
		expect(trusted.config.remindersMax).toBe(5);
		expect(trusted.config.eager).toBe("preferred");
		expect(trusted.projectTrusted).toBe(true);

		const untrusted = loadTodoConfig(cwd, () => false, warn);
		expect(untrusted.config.remindersMax).toBe(3);
		expect(untrusted.config.eager).toBe("default");
		expect(untrusted.projectTrusted).toBe(false);
	});

	it("a global enabled:false is a floor the project cannot lift", () => {
		const { cwd } = setupDirs(
			JSON.stringify({ enabled: false }),
			JSON.stringify({ enabled: true }),
		);
		const loaded = loadTodoConfig(cwd, () => true, warn);
		expect(loaded.config.enabled).toBe(false);
	});

	it("ignores invalid values and warns", () => {
		const { cwd } = setupDirs(
			JSON.stringify({
				reminders: "yes",
				remindersMax: -1,
				eager: "sometimes",
			}),
			null,
		);
		const loaded = loadTodoConfig(cwd, () => true, warn);
		expect(loaded.config.reminders).toBe(true);
		expect(loaded.config.remindersMax).toBe(3);
		expect(loaded.config.eager).toBe("default");
		expect(warnings.length).toBeGreaterThan(0);
	});

	it("warns on invalid JSON and falls back to defaults", () => {
		const { cwd } = setupDirs("{ not json", null);
		const loaded = loadTodoConfig(cwd, () => true, warn);
		expect(loaded.config).toEqual(TODO_CONFIG_DEFAULTS);
		expect(warnings.some((message) => message.includes("invalid JSON"))).toBe(
			true,
		);
	});

	it("warns on unknown keys", () => {
		const { cwd } = setupDirs(JSON.stringify({ eagerMode: "always" }), null);
		loadTodoConfig(cwd, () => true, warn);
		expect(
			warnings.some((message) =>
				message.includes('unknown config key "eagerMode"'),
			),
		).toBe(true);
	});

	it("accepts a zero remindersMax (reminders disabled by count)", () => {
		const { cwd } = setupDirs(JSON.stringify({ remindersMax: 0 }), null);
		const loaded = loadTodoConfig(cwd, () => true, warn);
		expect(loaded.config.remindersMax).toBe(0);
	});

	it("resolves environment overrides over JSON", () => {
		const { cwd } = setupDirs(
			JSON.stringify({ enabled: true, reminders: true, remindersMax: 3, eager: "default" }),
			null,
		);
		const loaded = resolveTodoConfig(
			cwd,
			() => true,
			warn,
			() => undefined,
			{
				PI_TODO_ENABLED: "off",
				PI_TODO_REMINDERS: "off",
				PI_TODO_REMINDERS_MAX: "7",
				PI_TODO_EAGER: "preferred",
			},
		);
		expect(loaded.config).toEqual({
			enabled: false,
			reminders: false,
			remindersMax: 7,
			eager: "preferred",
		});
	});

	it("resolves flags over environment and preserves the global enabled floor", () => {
		const { cwd } = setupDirs(
			JSON.stringify({ enabled: false, reminders: true, remindersMax: 3, eager: "default" }),
			null,
		);
		const loaded = resolveTodoConfig(
			cwd,
			() => true,
			warn,
			(name) =>
				name === TODO_FLAGS.enabled
					? "on"
					: name === TODO_FLAGS.remindersMax
						? "2"
						: undefined,
				{
					PI_TODO_ENABLED: "off",
					PI_TODO_REMINDERS_MAX: "9",
				},
		);
		expect(loaded.config.enabled).toBe(false);
		expect(loaded.config.remindersMax).toBe(2);
	});

	it("persists and reads the complete global config", () => {
		setupDirs(null, null);
		const target = path.join(tempRoot, "saved", "todo.json");
		saveTodoConfig(
			{ enabled: false, reminders: false, remindersMax: 1, eager: "always" },
			target,
		);
		expect(readTodoConfig(target)).toEqual({
			enabled: false,
			reminders: false,
			remindersMax: 1,
			eager: "always",
		});
	});
});
