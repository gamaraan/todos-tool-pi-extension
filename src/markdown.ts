/**
 * Markdown checklist round-trip for todos: render phases to an editable
 * `# Phase` + `- [x] task` document and parse it back, plus path resolution
 * for `/todo export|import` targets.
 *
 * Ported from Oh My Pi's `packages/coding-agent/src/tools/todo.ts`
 * (Markdown round-trip section) and `src/tools/path-utils.ts` (the subset
 * used by `resolveTodoMarkdownPath`).
 */

import * as path from "node:path";
import { normalizeInProgressTask } from "./state.ts";
import type { TodoPhase, TodoStatus } from "./types.ts";

const STATUS_TO_MARKER: Record<TodoStatus, string> = {
	pending: " ",
	in_progress: "/",
	completed: "x",
	abandoned: "-",
	blocked: "!",
};

const MARKER_TO_STATUS: Record<string, TodoStatus> = {
	" ": "pending",
	"": "pending",
	x: "completed",
	X: "completed",
	"/": "in_progress",
	">": "in_progress",
	"-": "abandoned",
	"~": "abandoned",
	"!": "blocked",
};

/** Render todo phases as a Markdown checklist suitable for editing/copying. */
export function phasesToMarkdown(phases: TodoPhase[]): string {
	if (phases.length === 0) return "# Todos\n";
	const out: string[] = [];
	for (let i = 0; i < phases.length; i++) {
		const phase = phases[i];
		if (phase === undefined) continue;
		if (i > 0) out.push("");
		out.push(`# ${phase.name}`);
		for (const task of phase.tasks) {
			// A blocked task's reason rides in a trailing HTML comment: invisible in
			// rendered markdown, unambiguous to parse back (task content can't
			// contain the comment delimiters), so the note survives `/todo edit` and
			// export/import round-trips.
			const blockerNote =
				task.status === "blocked" && task.blocker
					? ` <!-- blocker: ${task.blocker} -->`
					: "";
			out.push(
				`- [${STATUS_TO_MARKER[task.status]}] ${task.content}${blockerNote}`,
			);
		}
	}
	return `${out.join("\n")}\n`;
}

/** Parse a Markdown checklist back into todo phases. */
export function markdownToPhases(md: string): {
	phases: TodoPhase[];
	errors: string[];
} {
	const errors: string[] = [];
	const phases: TodoPhase[] = [];
	let currentPhase: TodoPhase | undefined;

	const lines = md.split(/\r?\n/);
	for (let lineNum = 0; lineNum < lines.length; lineNum++) {
		const raw = lines[lineNum] ?? "";

		const trimmed = raw.trim();
		if (!trimmed) continue;

		const headingMatch = /^#{1,6}\s+(.+?)\s*$/.exec(trimmed);
		if (headingMatch) {
			currentPhase = { name: (headingMatch[1] ?? "").trim(), tasks: [] };
			phases.push(currentPhase);
			continue;
		}

		const taskMatch = /^[-*+]\s*\[(.?)\]\s+(.+?)\s*$/.exec(trimmed);
		if (taskMatch) {
			if (!currentPhase) {
				currentPhase = { name: "Todos", tasks: [] };
				phases.push(currentPhase);
			}
			const marker = taskMatch[1] ?? "";
			const status = MARKER_TO_STATUS[marker];
			if (!status) {
				errors.push(
					`Line ${lineNum + 1}: unknown status marker "[${marker}]" (use [ ], [x], [/], [-], [!])`,
				);
				continue;
			}
			// Recover a blocked task's reason from its trailing HTML comment (see
			// phasesToMarkdown), then strip the comment from the visible content.
			const rawContent = (taskMatch[2] ?? "").trim();
			const blockerMatch = /^(.*?)\s*<!--\s*blocker:\s*(.*?)\s*-->$/.exec(
				rawContent,
			);
			if (status === "blocked" && blockerMatch) {
				currentPhase.tasks.push({
					content: (blockerMatch[1] ?? "").trim(),
					status,
					blocker: (blockerMatch[2] ?? "").trim(),
				});
			} else {
				currentPhase.tasks.push({ content: rawContent, status });
			}
			continue;
		}

		errors.push(`Line ${lineNum + 1}: unrecognized syntax "${trimmed}"`);
	}

	normalizeInProgressTask(phases);
	return { phases, errors };
}

// =============================================================================
// Path resolution (subset of omp's path-utils used by resolveTodoMarkdownPath)
// =============================================================================

const TOP_LEVEL_INTERNAL_URL_PREFIXES = [
	"agent://",
	"artifact://",
	"skill://",
	"rule://",
	"security://",
];

const UNICODE_SPACES =
	/[\u0009\u000a\u000b\u000c\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/g;

function normalizeUnicodeSpaces(str: string): string {
	return str.replace(UNICODE_SPACES, " ");
}

function stripOuterDoubleQuotes(input: string): string {
	return input.startsWith('"') && input.endsWith('"') && input.length > 1
		? input.slice(1, -1)
		: input;
}

/** Expand a leading `~` (and `~user`) to the home directory. */
function expandHome(filePath: string): string {
	if (filePath === "~")
		return process.env.HOME ?? process.env.USERPROFILE ?? filePath;
	if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
		const home = process.env.HOME ?? process.env.USERPROFILE;
		if (home) return path.join(home, filePath.slice(2));
	}
	return filePath;
}

function assertNotInternalUrl(expanded: string, original: string): void {
	for (const prefix of TOP_LEVEL_INTERNAL_URL_PREFIXES) {
		if (expanded.startsWith(prefix)) {
			throw new Error(
				`Path "${original}" uses internal scheme "${prefix}" and must be resolved through the proper protocol handler, not as a filesystem path.`,
			);
		}
	}
}

/** Normalize a user-supplied todo file path and resolve it against `cwd`. */
export function resolveTodoMarkdownPath(input: string, cwd: string): string {
	const raw =
		normalizeUnicodeSpaces(stripOuterDoubleQuotes(input.trim())) || "TODO.md";
	const expanded = expandHome(raw);

	assertNotInternalUrl(expanded, raw);

	if (/^\/+$/.test(expanded)) {
		return cwd;
	}
	if (path.isAbsolute(expanded)) {
		return expanded;
	}
	return path.resolve(cwd, expanded);
}

/** Convenience re-export used by the renderer for status markers. */
export function todoStatusMarker(status: TodoStatus): string {
	return STATUS_TO_MARKER[status];
}

// Re-export for consumers that want the marker tables (e.g. tests).
export { STATUS_TO_MARKER, MARKER_TO_STATUS };
