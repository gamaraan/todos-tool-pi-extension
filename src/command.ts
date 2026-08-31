/**
 * `/todo` slash command controller.
 *
 * Ported from Oh My Pi's
 * `packages/coding-agent/src/modes/controllers/todo-command-controller.ts`,
 * adapted to pi's extension command context:
 *
 * - `showStatus/showError/showWarning` → host notifications (or stdout in
 *   headless modes).
 * - `$EDITOR` editing is only used outside the TUI; inside the TUI the host
 *   opens pi's native multi-line editor dialog.
 * - `copyToClipboard` → host clipboard (OSC 52 in TUI; unsupported elsewhere).
 * - The commit path persists a `user_todo_edit` custom entry and injects the
 *   hidden "manual edit" reminder the same way omp does.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { applyOpsToPhases } from "./state.ts";
import { getLatestTodoPhasesFromEntries } from "./persistence.ts";
import {
	markdownToPhases,
	phasesToMarkdown,
	resolveTodoMarkdownPath,
} from "./markdown.ts";
import type {
	TodoItem,
	TodoOperation,
	TodoParams,
	TodoPhase,
} from "./types.ts";

const USAGE = [
	"Usage: /todo <verb> [args]",
	"  /todo                              Show current todos",
	"  /todo edit                         Open todos in $EDITOR",
	"  /todo copy                         Copy todos as Markdown to clipboard",
	"  /todo export [<path>]              Write todos to file (default: TODO.md)",
	"  /todo import [<path>]              Replace todos from file (default: TODO.md)",
	"  /todo append [<phase>] <task...>   Append a task; phase fuzzy-matched or auto-created",
	"  /todo start  <task>                Mark task in_progress (fuzzy content match)",
	"  /todo done   [<task|phase>]        Mark task/phase/all completed",
	"  /todo drop   [<task|phase>]        Mark task/phase/all abandoned",
	"  /todo rm     [<task|phase>]        Remove task/phase/all",
].join("\n");

/** Capabilities the /todo command borrows from the hosting extension. */
export interface TodoCommandHost {
	getPhases(): TodoPhase[];
	setPhases(phases: TodoPhase[]): void;
	getBranch(): SessionEntry[];
	getCwd(): string;
	/** Persist a manual edit: custom entry + hidden reminder + HUD refresh. */
	commit(
		phases: TodoPhase[],
		action: string,
		opts?: { removed?: boolean },
	): void;
	/** Report a committed mutation to optional integrations. */
	onSuccessfulMutation?(previous: TodoPhase[], next: TodoPhase[]): void;
	notify(text: string, type: "info" | "warning" | "error"): void;
	/** Open the native multi-line editor; undefined = cancelled. */
	openEditor(title: string, prefill: string): Promise<string | undefined>;
	/** TUI clipboard copy via OSC 52; false when the terminal can't do it. */
	copyToClipboard(text: string): boolean;
	/** $EDITOR path on a temp file; null = editor exited without saving. */
	openExternalEditor(prefill: string): Promise<string | null>;
}

// =============================================================================
// Argument tokenizer (respects double-quoted strings)
// =============================================================================

function tokenize(input: string): string[] {
	const tokens: string[] = [];
	let cur = "";
	let inQuote = false;
	for (let i = 0; i < input.length; i++) {
		const ch = input[i] ?? "";
		if (ch === "\\" && i + 1 < input.length) {
			cur += input[++i];
			continue;
		}
		if (ch === '"') {
			inQuote = !inQuote;
			continue;
		}
		if (!inQuote && /\s/.test(ch)) {
			if (cur) {
				tokens.push(cur);
				cur = "";
			}
			continue;
		}
		cur += ch;
	}
	if (cur) tokens.push(cur);
	return tokens;
}

// =============================================================================
// Name normalization
// =============================================================================

function titleCase(s: string): string {
	return s
		.split(/\s+/)
		.filter(Boolean)
		.map((word) => word[0]?.toUpperCase() + word.slice(1))
		.join(" ");
}

/** Capitalize first letter only — keeps acronyms / casing in the rest of the sentence intact. */
function titleCaseSentence(s: string): string {
	const trimmed = s.trim();
	if (!trimmed) return trimmed;
	return trimmed[0]?.toUpperCase() + trimmed.slice(1);
}

// =============================================================================
// Fuzzy matching
// =============================================================================

function findPhaseFuzzy(
	phases: TodoPhase[],
	query: string,
): TodoPhase | undefined {
	const q = query.trim().toLowerCase();
	if (!q) return undefined;
	// Exact name (case-insensitive)
	const byName = phases.find((p) => p.name.toLowerCase() === q);
	if (byName) return byName;
	// Substring (prefer prefix match)
	const prefixMatches = phases.filter((p) =>
		p.name.toLowerCase().startsWith(q),
	);
	if (prefixMatches.length === 1) return prefixMatches[0];
	const subMatches = phases.filter((p) => p.name.toLowerCase().includes(q));
	if (subMatches.length === 1) return subMatches[0];
	return undefined;
}

function findTaskFuzzy(
	phases: TodoPhase[],
	query: string,
): { task: TodoItem; phase: TodoPhase } | undefined {
	const q = query.trim().toLowerCase();
	if (!q) return undefined;
	// Exact content (case-insensitive)
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.content.toLowerCase() === q) return { task, phase };
		}
	}
	const matches: Array<{ task: TodoItem; phase: TodoPhase }> = [];
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.content.toLowerCase().includes(q)) {
				matches.push({ task, phase });
			}
		}
	}
	if (matches.length === 1) return matches[0];
	// Prefer single in_progress/pending hit when ambiguous
	const active = matches.filter(
		(m) => m.task.status === "in_progress" || m.task.status === "pending",
	);
	if (active.length === 1) return active[0];
	return undefined;
}

// =============================================================================
// Build system reminder
// =============================================================================

export function buildSystemReminder(
	action: string,
	phases: TodoPhase[],
	removed = false,
): string {
	const md =
		phases.length === 0 ? "(empty)" : phasesToMarkdown(phases).trimEnd();
	const lines = [
		"<system-reminder>",
		`The user manually modified the todo list (${action}).`,
	];
	if (removed) {
		lines.push(
			phases.length === 0
				? "The user intentionally cleared the todo list. Do NOT recreate or re-populate it unless the user explicitly asks; continue the current request without a todo list."
				: "The user intentionally removed the entries no longer shown below. Do NOT re-add them unless the user explicitly asks.",
		);
	}
	lines.push("Current todo list:", "", md, "</system-reminder>");
	return lines.join("\n");
}

// =============================================================================
// Controller
// =============================================================================

export class TodoCommandController {
	constructor(private readonly host: TodoCommandHost) {}

	/**
	 * True latest todo state for the user-facing /todo verbs. Reads from
	 * session entries or falls back to the active in-memory state.
	 */
	#currentPhases(): TodoPhase[] {
		const fromEntries = getLatestTodoPhasesFromEntries(this.host.getBranch());
		if (fromEntries.length > 0) return fromEntries;
		return this.host.getPhases();
	}

	async handleTodoCommand(args: string): Promise<void> {
		const trimmed = args.trim();
		if (!trimmed) {
			this.#showCurrent();
			return;
		}

		const spaceIdx = trimmed.search(/\s/);
		const verb = (
			spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)
		).toLowerCase();
		const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

		switch (verb) {
			case "edit":
				await this.#editInEditor();
				return;
			case "copy":
				this.#copyMarkdown();
				return;
			case "export":
				await this.#exportToFile(rest);
				return;
			case "import":
				await this.#importFromFile(rest);
				return;
			case "help":
			case "?":
				this.host.notify(USAGE, "info");
				return;
			case "append":
				this.#append(rest);
				return;
			case "start":
				this.#start(rest);
				return;
			case "done":
				this.#mutateStatus(rest, "completed");
				return;
			case "drop":
				this.#mutateStatus(rest, "abandoned");
				return;
			case "rm":
				this.#remove(rest);
				return;
			default:
				this.host.notify(`Unknown /todo verb "${verb}".\n${USAGE}`, "error");
		}
	}

	#showCurrent(): void {
		const phases = this.#currentPhases();
		if (phases.length === 0) {
			this.host.notify(
				"No todos. Use /todo append <task> to start one.",
				"info",
			);
			return;
		}
		this.host.notify(phasesToMarkdown(phases).trimEnd(), "info");
	}

	#copyMarkdown(): void {
		const phases = this.#currentPhases();
		if (phases.length === 0) {
			this.host.notify("No todos to copy.", "warning");
			return;
		}
		if (!this.host.copyToClipboard(phasesToMarkdown(phases))) {
			this.host.notify("Copying requires interactive mode.", "error");
			return;
		}
		this.host.notify("Copied todos as Markdown to clipboard.", "info");
	}

	#resolveTodoPath(rest: string): string {
		return resolveTodoMarkdownPath(rest, this.host.getCwd());
	}

	async #exportToFile(rest: string): Promise<void> {
		const phases = this.#currentPhases();
		if (phases.length === 0) {
			this.host.notify("No todos to export.", "warning");
			return;
		}
		try {
			const target = this.#resolveTodoPath(rest);
			await fs.writeFile(target, phasesToMarkdown(phases), "utf8");
			this.host.notify(`Wrote todos to ${target}`, "info");
		} catch (error) {
			this.host.notify(
				`Failed to write todos: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		}
	}

	async #importFromFile(rest: string): Promise<void> {
		let source = "";
		let content: string;
		try {
			source = this.#resolveTodoPath(rest);
			content = await fs.readFile(source, "utf8");
		} catch (error) {
			this.host.notify(
				`Failed to read todos: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			return;
		}
		const { phases, errors } = markdownToPhases(content);
		if (errors.length > 0) {
			this.host.notify(
				`Could not parse ${source}:\n  ${errors.join("\n  ")}`,
				"error",
			);
			return;
		}
		this.#commit(phases, `/todo import ${source}`);
		const taskCount = phases.reduce((sum, p) => sum + p.tasks.length, 0);
		this.host.notify(
			`Imported ${phases.length} phase(s), ${taskCount} task(s) from ${source}.`,
			"info",
		);
	}

	// ------------------------------------------------------------- append

	#append(rest: string): void {
		const tokens = tokenize(rest);
		if (tokens.length === 0) {
			this.host.notify("Usage: /todo append [<phase>] <task...>", "error");
			return;
		}

		const current = this.#currentPhases();
		let phaseName: string | undefined;
		let content: string;

		if (tokens.length === 1) {
			content = tokens[0] ?? "";
		} else {
			phaseName = tokens[0];
			content = tokens.slice(1).join(" ");
		}

		const next = current.map((phase) => ({
			...phase,
			tasks: phase.tasks.slice(),
		}));
		let targetPhase: TodoPhase | undefined;

		if (phaseName) {
			targetPhase = findPhaseFuzzy(next, phaseName);
			if (!targetPhase) {
				targetPhase = { name: titleCase(phaseName), tasks: [] };
				next.push(targetPhase);
			}
		} else if (next.length > 0) {
			targetPhase = next[next.length - 1];
		} else {
			targetPhase = { name: "Todos", tasks: [] };
			next.push(targetPhase);
		}
		if (!targetPhase) return;

		const finalContent = titleCaseSentence(content);
		targetPhase.tasks.push({
			content: finalContent,
			status: "pending",
		});

		this.#commit(next, `/todo append → ${targetPhase.name}`);
		this.host.notify(
			`Appended to ${targetPhase.name}: ${finalContent}`,
			"info",
		);
	}

	// ------------------------------------------------------------- start / done / drop / rm

	#start(rest: string): void {
		if (!rest) {
			this.host.notify("Usage: /todo start <task>", "error");
			return;
		}
		const current = this.#currentPhases();
		const hit = findTaskFuzzy(current, rest);
		if (!hit) {
			this.host.notify(
				`No task matched "${rest}". Use /todo to list current tasks.`,
				"error",
			);
			return;
		}
		const { phases, errors } = applyOpsToPhases(current, [
			{ op: "start", task: hit.task.content },
		]);
		if (errors.length > 0) {
			this.host.notify(errors.join("; "), "error");
			return;
		}
		this.#commit(phases, `/todo start ${hit.task.content}`);
		this.host.notify(`Started: ${hit.task.content}`, "info");
	}

	#mutateStatus(rest: string, target: "completed" | "abandoned"): void {
		const op: TodoOperation = target === "completed" ? "done" : "drop";
		const current = this.#currentPhases();
		const trimmed = rest.trim();
		if (!trimmed) {
			// no-arg: apply to all
			const { phases, errors } = applyOpsToPhases(current, [
				{ op } as TodoParams,
			]);
			if (errors.length > 0) {
				this.host.notify(errors.join("; "), "error");
				return;
			}
			this.#commit(phases, `/todo ${op} (all)`);
			this.host.notify(`Marked all tasks ${target}.`, "info");
			return;
		}

		const taskHit = findTaskFuzzy(current, trimmed);
		if (taskHit) {
			const { phases, errors } = applyOpsToPhases(current, [
				{ op, task: taskHit.task.content },
			]);
			if (errors.length > 0) {
				this.host.notify(errors.join("; "), "error");
				return;
			}
			this.#commit(phases, `/todo ${op} ${taskHit.task.content}`);
			this.host.notify(`Marked ${target}: ${taskHit.task.content}`, "info");
			return;
		}

		const phaseHit = findPhaseFuzzy(current, trimmed);
		if (phaseHit) {
			const { phases, errors } = applyOpsToPhases(current, [
				{ op, phase: phaseHit.name },
			]);
			if (errors.length > 0) {
				this.host.notify(errors.join("; "), "error");
				return;
			}
			this.#commit(phases, `/todo ${op} ${phaseHit.name}`);
			this.host.notify(`Marked phase ${phaseHit.name} ${target}.`, "info");
			return;
		}

		this.host.notify(`No task or phase matched "${trimmed}".`, "error");
	}

	#remove(rest: string): void {
		const current = this.#currentPhases();
		const trimmed = rest.trim();
		if (!trimmed) {
			this.#commit([], "/todo rm (all)", { removed: true });
			this.host.notify("Cleared all todos.", "info");
			return;
		}
		const taskHit = findTaskFuzzy(current, trimmed);
		if (taskHit) {
			const { phases, errors } = applyOpsToPhases(current, [
				{ op: "rm", task: taskHit.task.content },
			]);
			if (errors.length > 0) {
				this.host.notify(errors.join("; "), "error");
				return;
			}
			this.#commit(phases, `/todo rm ${taskHit.task.content}`, {
				removed: true,
			});
			this.host.notify(`Removed: ${taskHit.task.content}`, "info");
			return;
		}
		const phaseHit = findPhaseFuzzy(current, trimmed);
		if (phaseHit) {
			const { phases, errors } = applyOpsToPhases(current, [
				{ op: "rm", phase: phaseHit.name },
			]);
			if (errors.length > 0) {
				this.host.notify(errors.join("; "), "error");
				return;
			}
			this.#commit(phases, `/todo rm ${phaseHit.name}`, { removed: true });
			this.host.notify(`Removed phase: ${phaseHit.name}`, "info");
			return;
		}
		this.host.notify(`No task or phase matched "${trimmed}".`, "error");
	}

	// ------------------------------------------------------------- editor

	async #editInEditor(): Promise<void> {
		const current = this.#currentPhases();
		const initialMarkdown =
			current.length > 0
				? phasesToMarkdown(current)
				: "# Todos\n- [ ] (replace this with your tasks)\n";

		const edited = await this.host.openEditor("Edit todos", initialMarkdown);
		if (edited === undefined) {
			this.host.notify(
				"Editor exited without saving; todos unchanged.",
				"warning",
			);
			return;
		}
		if (edited === initialMarkdown) {
			this.host.notify("No changes; todos unchanged.", "info");
			return;
		}
		const { phases: parsed, errors } = markdownToPhases(edited);
		if (errors.length > 0) {
			this.host.notify(
				`Could not parse Markdown:\n  ${errors.join("\n  ")}`,
				"error",
			);
			return;
		}
		this.#commit(parsed, "/todo edit");
		const taskCount = parsed.reduce((sum, p) => sum + p.tasks.length, 0);
		this.host.notify(
			`Todos updated from editor: ${parsed.length} phase(s), ${taskCount} task(s).`,
			"info",
		);
	}

	#commit(
		nextPhases: TodoPhase[],
		action: string,
		opts?: { removed?: boolean },
	): void {
		const previousPhases = this.#currentPhases();
		this.host.commit(nextPhases, action, opts);
		this.host.onSuccessfulMutation?.(previousPhases, nextPhases);
	}
}

// =============================================================================
// External $EDITOR helper (non-TUI fallback)
// =============================================================================

export function getEditorCommand(): string | undefined {
	const configured = (process.env.VISUAL ?? process.env.EDITOR ?? "").trim();
	if (configured) return configured;
	return undefined;
}

/**
 * Open `content` in the user's external editor and return the edited text.
 * Returns `null` when the editor exits with a non-zero code. The temp file is
 * always cleaned up.
 */
export async function openInExternalEditor(
	editorCmd: string,
	content: string,
): Promise<string | null> {
	// mkdtemp (0700, O_EXCL) instead of a predictable pid/timestamp filename:
	// on a multi-user machine a guessed tmp name can be pre-created as a
	// symlink and the write would follow it. The prefill can hold sensitive
	// session data, so the file itself is 0600.
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "todos-edit-"));
	const tmpFile = path.join(tmpDir, "todos.md");
	try {
		await fs.writeFile(tmpFile, content, { encoding: "utf8", mode: 0o600 });
		const exitCode = await runEditorProcess(editorCmd, tmpFile);
		if (exitCode !== 0) return null;
		return await fs.readFile(tmpFile, "utf8");
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
	}
}

function runEditorProcess(
	editorCmd: string,
	filePath: string,
): Promise<number> {
	// Split the configured editor into [command, ...args] (e.g. "code --wait")
	// and spawn directly — no shell indirection, matching omp's own spawn.
	const [editor, ...editorArgs] = editorCmd.split(/\s+/).filter(Boolean);
	if (!editor) return Promise.resolve(1);
	return new Promise((resolve, reject) => {
		const child = spawn(editor, [...editorArgs, filePath], {
			stdio: "inherit",
		});
		child.once("error", reject);
		child.once("exit", (code, signal) => resolve(code ?? (signal ? -1 : 0)));
	});
}
