import { exec } from "node:child_process";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { promisify } from "node:util";
import { configRegistry } from "@codelia/config";
import { loadConfig, updateModelConfig } from "@codelia/config-loader";
import {
	Agent,
	applyModelMetadata,
	type BaseChatModel,
	ChatAnthropic,
	ChatOpenAI,
	DEFAULT_MODEL_REGISTRY,
	type DependencyKey,
	defineTool,
	getDefaultSystemPromptPath,
	type ModelRegistry,
	TaskComplete,
	type Tool,
	type ToolContext,
	type ToolOutputCacheStore,
} from "@codelia/core";
import { ModelMetadataServiceImpl } from "@codelia/model-metadata";
import {
	StoragePathServiceImpl,
	ToolOutputCacheStoreImpl,
} from "@codelia/storage";
import { z } from "zod";
import { renderEvent } from "./event-presenter";

const execAsync = promisify(exec);
const DEFAULT_SYSTEM_PROMPT = "You are a coding assistant.";
const MAX_EXEC_TIMEOUT_MS = 2_147_483_647;
const MAX_EXEC_TIMEOUT_SECONDS = Math.floor(MAX_EXEC_TIMEOUT_MS / 1000);
const describeError = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);
const readEnvValue = (key: string): string | undefined => {
	const value = process.env[key];
	if (!value) return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
};

const resolveConfigPath = (): string => {
	const envPath = readEnvValue("CODELIA_CONFIG_PATH");
	if (envPath) return path.resolve(envPath);
	const storage = new StoragePathServiceImpl();
	return storage.resolvePaths().configFile;
};

const resolveModelConfig = async (): Promise<{
	provider?: string;
	name?: string;
	reasoning?: string;
}> => {
	const configPath = resolveConfigPath();
	try {
		const config = await loadConfig(configPath);
		const effective = configRegistry.resolve([config]);
		return {
			provider: effective.model?.provider,
			name: effective.model?.name,
			reasoning: effective.model?.reasoning,
		};
	} catch (error) {
		const message = describeError(error);
		throw new Error(`Failed to load config.json: ${message}`);
	}
};

type ModelConfig = Awaited<ReturnType<typeof resolveModelConfig>>;

const resolveReasoningEffort = (
	value?: string,
): "low" | "medium" | "high" | undefined => {
	if (!value) return undefined;
	const normalized = value.trim().toLowerCase();
	if (
		normalized === "low" ||
		normalized === "medium" ||
		normalized === "high"
	) {
		return normalized;
	}
	throw new Error(
		`Invalid model.reasoning: ${value}. Expected low|medium|high.`,
	);
};

const loadSystemPrompt = async (workingDir: string): Promise<string> => {
	const promptPath = process.env.CODELIA_SYSTEM_PROMPT_PATH
		? path.resolve(process.env.CODELIA_SYSTEM_PROMPT_PATH)
		: getDefaultSystemPromptPath();
	try {
		const raw = await fs.readFile(promptPath, "utf8");
		const trimmed = raw.trim();
		if (!trimmed) {
			return `${DEFAULT_SYSTEM_PROMPT}\nWorking directory: ${workingDir}`;
		}
		return trimmed.includes("{{working_dir}}")
			? trimmed.replaceAll("{{working_dir}}", workingDir)
			: `${trimmed}\n\nWorking directory: ${workingDir}`;
	} catch {
		return `${DEFAULT_SYSTEM_PROMPT}\nWorking directory: ${workingDir}`;
	}
};

class SecurityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SecurityError";
	}
}

const formatSecurityError = (error: unknown): string =>
	`Security error: ${String(error)}`;

type SandboxContextInit = {
	rootDir: string;
	workingDir: string;
	sessionId: string;
};

class SandboxContext {
	readonly rootDir: string;
	readonly workingDir: string;
	readonly sessionId: string;

	private constructor(init: SandboxContextInit) {
		this.rootDir = init.rootDir;
		this.workingDir = init.workingDir;
		this.sessionId = init.sessionId;
	}

	static async create(rootDir?: string): Promise<SandboxContext> {
		const sessionId = crypto.randomUUID().slice(0, 8);
		const root = rootDir ? path.resolve(rootDir) : process.cwd();
		await fs.mkdir(root, { recursive: true });
		return new SandboxContext({
			rootDir: root,
			workingDir: root,
			sessionId,
		});
	}

	resolvePath(targetPath: string): string {
		const resolved = path.isAbsolute(targetPath)
			? path.resolve(targetPath)
			: path.resolve(this.workingDir, targetPath);
		const relative = path.relative(this.rootDir, resolved);
		if (
			relative === "" ||
			(!relative.startsWith("..") && !path.isAbsolute(relative))
		) {
			return resolved;
		}
		throw new SecurityError(
			`Path escapes sandbox: ${targetPath} -> ${resolved}`,
		);
	}
}

const createSandboxKey = (
	ctx: SandboxContext,
): DependencyKey<SandboxContext> => ({
	id: "sandbox-context",
	create: () => ctx,
});

const getSandboxContext = async (
	ctx: ToolContext,
	key: DependencyKey<SandboxContext>,
): Promise<SandboxContext> => ctx.resolve(key);

type ResolvedPathResult =
	| { ok: true; resolved: string }
	| { ok: false; error: string };

type SearchPathResult =
	| { ok: true; rootDir: string; searchDir: string }
	| { ok: false; error: string };

const resolveSandboxPath = async (
	ctx: ToolContext,
	sandboxKey: DependencyKey<SandboxContext>,
	targetPath: string,
): Promise<ResolvedPathResult> => {
	try {
		const sandbox = await getSandboxContext(ctx, sandboxKey);
		return { ok: true, resolved: sandbox.resolvePath(targetPath) };
	} catch (error) {
		return { ok: false, error: formatSecurityError(error) };
	}
};

const resolveSandboxSearch = async (
	ctx: ToolContext,
	sandboxKey: DependencyKey<SandboxContext>,
	targetPath?: string,
): Promise<SearchPathResult> => {
	try {
		const sandbox = await getSandboxContext(ctx, sandboxKey);
		const searchDir = targetPath
			? sandbox.resolvePath(targetPath)
			: sandbox.workingDir;
		return { ok: true, rootDir: sandbox.rootDir, searchDir };
	} catch (error) {
		return { ok: false, error: formatSecurityError(error) };
	}
};

const createBashTool = (sandboxKey: DependencyKey<SandboxContext>): Tool =>
	defineTool({
		name: "bash",
		description: "Execute a shell command and return output",
		input: z.object({
			command: z.string(),
			timeout: z.number().int().positive().optional(),
		}),
		execute: async (input, ctx) => {
			const sandbox = await getSandboxContext(ctx, sandboxKey);
			const requestedTimeout = input.timeout ?? 30;
			const timeoutSeconds = Math.max(
				1,
				Math.min(Math.floor(requestedTimeout), MAX_EXEC_TIMEOUT_SECONDS),
			);
			try {
				const { stdout, stderr } = await execAsync(input.command, {
					cwd: sandbox.workingDir,
					timeout: timeoutSeconds * 1000,
					maxBuffer: 10 * 1024 * 1024,
				});
				const output = `${stdout}${stderr}`.trim();
				return output || "(no output)";
			} catch (error) {
				if (error && typeof error === "object" && "code" in error) {
					const code = (error as { code?: string | number }).code;
					if (code === "ETIMEDOUT") {
						return `Command timed out after ${timeoutSeconds}s`;
					}
				}
				return `Error: ${describeError(error)}`;
			}
		},
	});

const createReadTool = (sandboxKey: DependencyKey<SandboxContext>): Tool =>
	defineTool({
		name: "read",
		description: "Read contents of a file",
		input: z.object({ file_path: z.string() }),
		execute: async (input, ctx) => {
			const resolved = await resolveSandboxPath(
				ctx,
				sandboxKey,
				input.file_path,
			);
			if (!resolved.ok) return resolved.error;

			try {
				const stat = await fs.stat(resolved.resolved);
				if (stat.isDirectory()) {
					return `Path is a directory: ${input.file_path}`;
				}
			} catch {
				return `File not found: ${input.file_path}`;
			}

			try {
				const content = await fs.readFile(resolved.resolved, "utf8");
				const lines = content.split(/\r?\n/);
				const numbered = lines.map(
					(line, index) => `${String(index + 1).padStart(4, " ")}  ${line}`,
				);
				return numbered.join("\n");
			} catch (error) {
				return `Error reading file: ${String(error)}`;
			}
		},
	});

const createWriteTool = (sandboxKey: DependencyKey<SandboxContext>): Tool =>
	defineTool({
		name: "write",
		description: "Write content to a file",
		input: z.object({ file_path: z.string(), content: z.string() }),
		execute: async (input, ctx) => {
			const resolved = await resolveSandboxPath(
				ctx,
				sandboxKey,
				input.file_path,
			);
			if (!resolved.ok) return resolved.error;

			try {
				await fs.mkdir(path.dirname(resolved.resolved), { recursive: true });
				await fs.writeFile(resolved.resolved, input.content, "utf8");
				return `Wrote ${input.content.length} bytes to ${input.file_path}`;
			} catch (error) {
				return `Error writing file: ${String(error)}`;
			}
		},
	});

type EditMatchMode = "exact" | "line_trimmed" | "block_anchor" | "auto";
type ResolvedEditMatchMode = Exclude<EditMatchMode, "auto">;
type EditMatch = { start: number; end: number };
type EditMatchResult = { mode: ResolvedEditMatchMode; matches: EditMatch[] };

const trimLine = (line: string): string => line.replace(/\r$/, "").trim();

const lineRangeToIndices = (
	lines: string[],
	startLine: number,
	lineCount: number,
): { start: number; end: number } => {
	let startIndex = 0;
	for (let i = 0; i < startLine; i++) {
		startIndex += lines[i].length + 1;
	}
	let endIndex = startIndex;
	for (let i = 0; i < lineCount; i++) {
		endIndex += lines[startLine + i].length;
		if (i < lineCount - 1) {
			endIndex += 1;
		}
	}
	return { start: startIndex, end: endIndex };
};

const findExactMatches = (content: string, needle: string): EditMatch[] => {
	if (!needle) return [];
	const matches: EditMatch[] = [];
	let index = 0;
	while (index <= content.length) {
		const found = content.indexOf(needle, index);
		if (found === -1) break;
		matches.push({ start: found, end: found + needle.length });
		index = found + needle.length;
	}
	return matches;
};

const findLineTrimmedMatches = (
	content: string,
	needle: string,
): EditMatch[] => {
	const contentLines = content.split("\n");
	const needleLines = needle.split("\n");
	if (needleLines.at(-1) === "") needleLines.pop();
	if (needleLines.length === 0) return [];

	const matches: EditMatch[] = [];
	for (let i = 0; i <= contentLines.length - needleLines.length; i++) {
		let ok = true;
		for (let j = 0; j < needleLines.length; j++) {
			if (trimLine(contentLines[i + j]) !== trimLine(needleLines[j])) {
				ok = false;
				break;
			}
		}
		if (ok) {
			matches.push(lineRangeToIndices(contentLines, i, needleLines.length));
			i += needleLines.length - 1;
		}
	}
	return matches;
};

const findBlockAnchorMatches = (
	content: string,
	needle: string,
): EditMatch[] => {
	const contentLines = content.split("\n");
	const needleLines = needle.split("\n");
	if (needleLines.at(-1) === "") needleLines.pop();
	if (needleLines.length < 3) return [];

	const first = trimLine(needleLines[0]);
	const last = trimLine(needleLines[needleLines.length - 1]);
	const candidates: Array<{ startLine: number; score: number }> = [];

	for (let i = 0; i <= contentLines.length - needleLines.length; i++) {
		if (trimLine(contentLines[i]) !== first) continue;
		const endLine = i + needleLines.length - 1;
		if (trimLine(contentLines[endLine]) !== last) continue;

		let matches = 0;
		for (let j = 0; j < needleLines.length; j++) {
			if (trimLine(contentLines[i + j]) === trimLine(needleLines[j])) {
				matches++;
			}
		}
		candidates.push({ startLine: i, score: matches / needleLines.length });
	}

	if (candidates.length === 0) return [];
	const bestScore = Math.max(...candidates.map((c) => c.score));
	return candidates
		.filter((c) => c.score === bestScore)
		.map((c) =>
			lineRangeToIndices(contentLines, c.startLine, needleLines.length),
		);
};

const resolveEditMatches = (
	content: string,
	needle: string,
	mode: EditMatchMode,
): EditMatchResult | null => {
	const exact = () => ({
		mode: "exact" as const,
		matches: findExactMatches(content, needle),
	});
	const lineTrimmed = () => ({
		mode: "line_trimmed" as const,
		matches: findLineTrimmedMatches(content, needle),
	});
	const blockAnchor = () => ({
		mode: "block_anchor" as const,
		matches: findBlockAnchorMatches(content, needle),
	});

	if (mode === "exact") return exact();
	if (mode === "line_trimmed") return lineTrimmed();
	if (mode === "block_anchor") return blockAnchor();

	const exactResult = exact();
	if (exactResult.matches.length) return exactResult;
	const lineResult = lineTrimmed();
	if (lineResult.matches.length) return lineResult;
	const blockResult = blockAnchor();
	if (blockResult.matches.length) return blockResult;
	return null;
};

const applyReplacements = (
	content: string,
	matches: EditMatch[],
	replacement: string,
): string => {
	const sorted = [...matches].sort((a, b) => b.start - a.start);
	let next = content;
	for (const match of sorted) {
		next = `${next.slice(0, match.start)}${replacement}${next.slice(match.end)}`;
	}
	return next;
};

const normalizeLineEndings = (text: string): string =>
	text.replace(/\r\n/g, "\n");

const toLines = (text: string): string[] =>
	text === "" ? [] : text.split("\n");

const createUnifiedDiff = (
	filePath: string,
	before: string,
	after: string,
	context = 3,
): string => {
	const oldText = normalizeLineEndings(before);
	const newText = normalizeLineEndings(after);
	if (oldText === newText) return "";

	const oldLines = toLines(oldText);
	const newLines = toLines(newText);
	let prefix = 0;
	while (
		prefix < oldLines.length &&
		prefix < newLines.length &&
		oldLines[prefix] === newLines[prefix]
	) {
		prefix++;
	}
	let suffix = 0;
	while (
		suffix < oldLines.length - prefix &&
		suffix < newLines.length - prefix &&
		oldLines[oldLines.length - 1 - suffix] ===
			newLines[newLines.length - 1 - suffix]
	) {
		suffix++;
	}

	const oldChangeStart = prefix;
	const oldChangeEnd = oldLines.length - suffix;
	const newChangeStart = prefix;
	const newChangeEnd = newLines.length - suffix;

	const hunkOldStart = Math.max(0, oldChangeStart - context);
	const hunkOldEnd = Math.min(oldLines.length, oldChangeEnd + context);
	const hunkNewStart = Math.max(0, newChangeStart - context);
	const hunkNewEnd = Math.min(newLines.length, newChangeEnd + context);

	const hunkOldLen = hunkOldEnd - hunkOldStart;
	const hunkNewLen = hunkNewEnd - hunkNewStart;
	const oldStartLine = hunkOldLen === 0 ? 0 : hunkOldStart + 1;
	const newStartLine = hunkNewLen === 0 ? 0 : hunkNewStart + 1;

	const header = [
		`--- ${filePath}`,
		`+++ ${filePath}`,
		`@@ -${oldStartLine},${hunkOldLen} +${newStartLine},${hunkNewLen} @@`,
	];

	const lines: string[] = [];
	for (let i = hunkOldStart; i < oldChangeStart; i++) {
		lines.push(` ${oldLines[i]}`);
	}
	for (let i = oldChangeStart; i < oldChangeEnd; i++) {
		lines.push(`-${oldLines[i]}`);
	}
	for (let i = newChangeStart; i < newChangeEnd; i++) {
		lines.push(`+${newLines[i]}`);
	}
	for (let i = oldChangeEnd; i < hunkOldEnd; i++) {
		lines.push(` ${oldLines[i]}`);
	}

	return `${header.join("\n")}\n${lines.join("\n")}`;
};

const hashContent = (content: string): string =>
	crypto.createHash("sha256").update(content).digest("hex");

const createEditTool = (sandboxKey: DependencyKey<SandboxContext>): Tool =>
	defineTool({
		name: "edit",
		description: "Replace text in a file",
		input: z.object({
			file_path: z.string(),
			old_string: z.string(),
			new_string: z.string(),
			replace_all: z.boolean().optional(),
			match_mode: z
				.enum(["exact", "line_trimmed", "block_anchor", "auto"])
				.optional(),
			expected_replacements: z.number().int().nonnegative().optional(),
			dry_run: z.boolean().optional(),
			expected_hash: z.string().optional(),
		}),
		execute: async (input, ctx) => {
			const resolved = await resolveSandboxPath(
				ctx,
				sandboxKey,
				input.file_path,
			);
			if (!resolved.ok) return resolved.error;

			if (input.old_string !== "" && input.old_string === input.new_string) {
				return {
					summary: `No changes needed in ${input.file_path} (old_string equals new_string)`,
					replacements: 0,
					match_mode: "exact" as const,
					diff: "",
					file_path: input.file_path,
				};
			}

			const replaceAll = input.replace_all ?? false;
			const matchMode = input.match_mode ?? "auto";
			const dryRun = input.dry_run ?? false;

			let content = "";
			let fileExists = false;
			try {
				const stat = await fs.stat(resolved.resolved);
				if (stat.isDirectory()) {
					return `Path is a directory: ${input.file_path}`;
				}
				fileExists = true;
				content = await fs.readFile(resolved.resolved, "utf8");
			} catch (_error) {
				if (input.old_string !== "") {
					return `File not found: ${input.file_path}`;
				}
			}

			if (input.expected_hash) {
				if (!fileExists) {
					return `Expected hash provided but file not found: ${input.file_path}`;
				}
				const currentHash = hashContent(content);
				if (currentHash !== input.expected_hash) {
					return `Hash mismatch for ${input.file_path}`;
				}
			}

			let replacements = 0;
			let modeUsed: ResolvedEditMatchMode = "exact";
			let nextContent = content;

			if (input.old_string === "") {
				nextContent = input.new_string;
				replacements = content === nextContent ? 0 : 1;
			} else {
				const matchResult = resolveEditMatches(
					content,
					input.old_string,
					matchMode,
				);
				if (!matchResult || matchResult.matches.length === 0) {
					return `String not found in ${input.file_path}`;
				}
				modeUsed = matchResult.mode;
				let matches = matchResult.matches;
				if (!replaceAll && matches.length > 1) {
					return `Multiple matches (${matches.length}) found in ${input.file_path}`;
				}
				if (!replaceAll) {
					matches = [matches[0]];
				}
				replacements = matches.length;
				nextContent = applyReplacements(content, matches, input.new_string);
			}

			if (
				input.expected_replacements !== undefined &&
				replacements !== input.expected_replacements
			) {
				return `Expected ${input.expected_replacements} replacements, found ${replacements}`;
			}

			const diff = createUnifiedDiff(input.file_path, content, nextContent);

			if (dryRun) {
				return {
					summary: `Preview: ${replacements} replacement(s) in ${input.file_path}`,
					replacements,
					match_mode: modeUsed,
					diff,
					file_path: input.file_path,
				};
			}

			if (content === nextContent) {
				return {
					summary: `No changes needed in ${input.file_path}`,
					replacements,
					match_mode: modeUsed,
					diff,
					file_path: input.file_path,
				};
			}

			try {
				await fs.mkdir(path.dirname(resolved.resolved), { recursive: true });
				await fs.writeFile(resolved.resolved, nextContent, "utf8");
			} catch (error) {
				return `Error editing file: ${String(error)}`;
			}

			return {
				summary: `Replaced ${replacements} occurrence(s) in ${input.file_path}`,
				replacements,
				match_mode: modeUsed,
				diff,
				file_path: input.file_path,
			};
		},
	});

const createGlobSearchTool = (
	sandboxKey: DependencyKey<SandboxContext>,
): Tool =>
	defineTool({
		name: "glob_search",
		description: "Find files matching a glob pattern",
		input: z.object({ pattern: z.string(), path: z.string().optional() }),
		execute: async (input, ctx) => {
			const resolved = await resolveSandboxSearch(ctx, sandboxKey, input.path);
			if (!resolved.ok) return resolved.error;

			try {
				const stat = await fs.stat(resolved.searchDir);
				if (!stat.isDirectory()) {
					return `Path is not a directory: ${input.path}`;
				}
			} catch (error) {
				return `Error: ${String(error)}`;
			}

			const matches = await globMatch(
				resolved.searchDir,
				resolved.rootDir,
				input.pattern,
			);
			if (!matches.length) {
				return `No files match pattern: ${input.pattern}`;
			}
			const limited = matches.slice(0, 50);
			return `Found ${limited.length} file(s):\n${limited.join("\n")}`;
		},
	});

const createGrepTool = (sandboxKey: DependencyKey<SandboxContext>): Tool =>
	defineTool({
		name: "grep",
		description: "Search file contents with regex",
		input: z.object({ pattern: z.string(), path: z.string().optional() }),
		execute: async (input, ctx) => {
			const resolved = await resolveSandboxSearch(ctx, sandboxKey, input.path);
			if (!resolved.ok) return resolved.error;

			let regex: RegExp;
			try {
				regex = new RegExp(input.pattern);
			} catch (error) {
				return `Invalid regex: ${String(error)}`;
			}

			const results: string[] = [];
			await walkFiles(resolved.searchDir, async (filePath) => {
				if (results.length >= 50) return false;
				try {
					const content = await fs.readFile(filePath, "utf8");
					const lines = content.split(/\r?\n/);
					for (let i = 0; i < lines.length; i++) {
						if (regex.test(lines[i])) {
							const relPath = path
								.relative(resolved.rootDir, filePath)
								.replaceAll("\\", "/");
							results.push(`${relPath}:${i + 1}: ${lines[i].slice(0, 100)}`);
							if (results.length >= 50) return false;
						}
					}
				} catch {
					return true;
				}
				return true;
			});

			if (!results.length) {
				return `No matches for: ${input.pattern}`;
			}
			return results.length >= 50
				? `${results.join("\n")}\n... (truncated)`
				: results.join("\n");
		},
	});

const createToolOutputCacheTool = (store: ToolOutputCacheStore): Tool =>
	defineTool({
		name: "tool_output_cache",
		description:
			"Read cached tool output by ref_id. Optional offset/limit are line-based.",
		input: z.object({
			ref_id: z.string(),
			offset: z.number().int().nonnegative().optional(),
			limit: z.number().int().positive().optional(),
		}),
		execute: async (input) => {
			if (!store.read) {
				return "tool_output_cache is unavailable.";
			}
			try {
				return await store.read(input.ref_id, {
					offset: input.offset,
					limit: input.limit,
				});
			} catch (error) {
				return `Error reading tool output cache: ${String(error)}`;
			}
		},
	});

const createToolOutputCacheGrepTool = (store: ToolOutputCacheStore): Tool =>
	defineTool({
		name: "tool_output_cache_grep",
		description:
			"Search cached tool output by ref_id. Supports regex and before/after context.",
		input: z.object({
			ref_id: z.string(),
			pattern: z.string(),
			regex: z.boolean().optional(),
			before: z.number().int().nonnegative().optional(),
			after: z.number().int().nonnegative().optional(),
			max_matches: z.number().int().positive().optional(),
		}),
		execute: async (input) => {
			if (!store.grep) {
				return "tool_output_cache_grep is unavailable.";
			}
			try {
				return await store.grep(input.ref_id, {
					pattern: input.pattern,
					regex: input.regex,
					before: input.before,
					after: input.after,
					max_matches: input.max_matches,
				});
			} catch (error) {
				return `Error searching tool output cache: ${String(error)}`;
			}
		},
	});

const createTodoReadTool = (
	sandboxKey: DependencyKey<SandboxContext>,
	todoStore: Map<string, TodoItem[]>,
): Tool =>
	defineTool({
		name: "todo_read",
		description: "Read current todo list",
		input: z.object({}),
		execute: async (_input, ctx) => {
			const sandbox = await getSandboxContext(ctx, sandboxKey);
			const todos = todoStore.get(sandbox.sessionId) ?? [];
			if (!todos.length) return "Todo list is empty";
			return todos
				.map((todo, index) => {
					const status =
						todo.status === "completed"
							? "[x]"
							: todo.status === "in_progress"
								? "[>]"
								: "[ ]";
					return `${index + 1}. ${status} ${todo.content}`;
				})
				.join("\n");
		},
	});

const createTodoWriteTool = (
	sandboxKey: DependencyKey<SandboxContext>,
	todoStore: Map<string, TodoItem[]>,
): Tool =>
	defineTool({
		name: "todo_write",
		description: "Update the todo list",
		input: z.object({
			todos: z.array(
				z.object({
					content: z.string(),
					status: z.enum(["pending", "in_progress", "completed"]),
					activeForm: z.string().optional(),
				}),
			),
		}),
		execute: async (input, ctx) => {
			const sandbox = await getSandboxContext(ctx, sandboxKey);
			todoStore.set(sandbox.sessionId, input.todos);
			const stats = {
				pending: input.todos.filter((todo) => todo.status === "pending").length,
				inProgress: input.todos.filter((todo) => todo.status === "in_progress")
					.length,
				completed: input.todos.filter((todo) => todo.status === "completed")
					.length,
			};
			return `Updated todos: ${stats.pending} pending, ${stats.inProgress} in progress, ${stats.completed} completed`;
		},
	});

const createDoneTool = (): Tool =>
	defineTool({
		name: "done",
		description: "Signal that the task is complete",
		input: z.object({ message: z.string() }),
		execute: async (input) => {
			throw new TaskComplete(input.message);
		},
	});

const createTools = (
	sandboxKey: DependencyKey<SandboxContext>,
	toolOutputCacheStore: ToolOutputCacheStore,
): Tool[] => {
	const todoStore = new Map<string, TodoItem[]>();
	const bash = createBashTool(sandboxKey);
	const read = createReadTool(sandboxKey);
	const write = createWriteTool(sandboxKey);
	const edit = createEditTool(sandboxKey);
	const globSearch = createGlobSearchTool(sandboxKey);
	const grep = createGrepTool(sandboxKey);
	const toolOutputCache = createToolOutputCacheTool(toolOutputCacheStore);
	const toolOutputCacheGrep =
		createToolOutputCacheGrepTool(toolOutputCacheStore);
	const todoRead = createTodoReadTool(sandboxKey, todoStore);
	const todoWrite = createTodoWriteTool(sandboxKey, todoStore);
	const done = createDoneTool();

	return [
		bash,
		read,
		write,
		edit,
		globSearch,
		grep,
		toolOutputCache,
		toolOutputCacheGrep,
		todoRead,
		todoWrite,
		done,
	];
};

type UsageSummary = ReturnType<Agent["getUsageSummary"]>;

const formatUsageSummary = (summary: UsageSummary): string => {
	const lines = [
		"Usage summary:",
		`  calls: ${summary.total_calls}`,
		`  input tokens: ${summary.total_input_tokens}`,
		`  output tokens: ${summary.total_output_tokens}`,
		`  cached input tokens: ${summary.total_cached_input_tokens}`,
		`  cache creation tokens: ${summary.total_cache_creation_tokens}`,
		`  total tokens: ${summary.total_tokens}`,
	];

	const models = Object.entries(summary.by_model);
	if (models.length) {
		lines.push("By model:");
		for (const [model, stats] of models) {
			lines.push(
				`  ${model}: calls=${stats.calls} input=${stats.input_tokens} output=${stats.output_tokens} cached_input=${stats.cached_input_tokens} cache_creation=${stats.cache_creation_tokens} total=${stats.total_tokens}`,
			);
		}
	}

	return lines.join("\n");
};

type TodoItem = {
	content: string;
	status: "pending" | "in_progress" | "completed";
	activeForm?: string;
};

const globToRegExp = (pattern: string): RegExp => {
	const normalized = pattern.replaceAll("\\", "/");
	const globDirToken = "__GLOBSTAR_DIR__";
	const globAnyToken = "__GLOBSTAR__";
	const globSingleToken = "__GLOBSTAR_SINGLE__";
	const globCharToken = "__GLOBSTAR_CHAR__";
	const withTokens = normalized
		.replace(/\*\*\//g, globDirToken)
		.replace(/\*\*/g, globAnyToken)
		.replace(/\*/g, globSingleToken)
		.replace(/\?/g, globCharToken);
	const escaped = withTokens.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	const withGlobDir = escaped.replaceAll(globDirToken, "(?:.*/)?");
	const withGlobAny = withGlobDir.replaceAll(globAnyToken, ".*");
	const withSingle = withGlobAny.replaceAll(globSingleToken, "[^/]*");
	const withAny = withSingle.replaceAll(globCharToken, "[^/]");
	return new RegExp(`^${withAny}$`);
};

const globMatch = async (
	searchDir: string,
	rootDir: string,
	pattern: string,
): Promise<string[]> => {
	const regex = globToRegExp(pattern.replaceAll("\\", "/"));
	const matches: string[] = [];
	await walkFiles(searchDir, async (filePath) => {
		const relPath = path.relative(rootDir, filePath).replaceAll("\\", "/");
		if (regex.test(relPath)) {
			matches.push(relPath);
		}
		return matches.length < 50;
	});
	return matches;
};

const walkFiles = async (
	startDir: string,
	visitor: (filePath: string) => Promise<boolean> | boolean,
): Promise<void> => {
	const entries = await fs.readdir(startDir, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = path.join(startDir, entry.name);
		if (entry.isDirectory()) {
			await walkFiles(fullPath, visitor);
		} else if (entry.isFile()) {
			const shouldContinue = await visitor(fullPath);
			if (!shouldContinue) return;
		}
	}
};

const buildModelRegistry = async (
	llm: BaseChatModel,
): Promise<ModelRegistry> => {
	const metadataService = new ModelMetadataServiceImpl({
		storagePathService: new StoragePathServiceImpl(),
	});
	const entries = await metadataService.getAllModelEntries();
	const providerEntries = entries[llm.provider];
	const directEntry = providerEntries?.[llm.model];
	const fullIdEntry = providerEntries?.[`${llm.provider}/${llm.model}`];
	if (!directEntry && !fullIdEntry) {
		throw new Error(
			`Model metadata not found for ${llm.provider}/${llm.model}`,
		);
	}
	return applyModelMetadata(DEFAULT_MODEL_REGISTRY, { models: entries });
};

type CliArgs = {
	prompt: string;
	promptIndex: number;
	isOneShot: boolean;
	modelOverride?: string;
};

const parseCliArgs = (args: string[]): CliArgs => {
	let prompt = "";
	let promptIndex = -1;
	let modelOverride: string | undefined;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "-p" || arg === "--prompt") {
			promptIndex = i;
			prompt = args[i + 1]?.trim() ?? "";
			i++;
			continue;
		}
		if (arg === "-m" || arg === "--model") {
			modelOverride = args[i + 1]?.trim() || undefined;
			i++;
			continue;
		}
		if (arg.startsWith("--model=")) {
			modelOverride = arg.slice("--model=".length).trim() || undefined;
		}
	}

	return {
		prompt,
		promptIndex,
		isOneShot: promptIndex >= 0,
		modelOverride,
	};
};

const resolveModelSelection = (
	targetModel: string,
	defaultProvider: string,
): { provider: "openai" | "anthropic"; name: string } => {
	const [providerCandidate, nameCandidate] = targetModel.includes("/")
		? (targetModel.split("/", 2) as [string, string])
		: [defaultProvider, targetModel];
	if (providerCandidate !== "openai" && providerCandidate !== "anthropic") {
		throw new Error(`Unsupported provider: ${providerCandidate}`);
	}
	if (!nameCandidate) {
		throw new Error("Model name is required.");
	}
	return { provider: providerCandidate, name: nameCandidate };
};

const runAgentPrompt = async (
	agent: Agent,
	text: string,
	isOneShot: boolean,
): Promise<void> => {
	let lastText = "";
	let finalText = "";
	for await (const event of agent.runStream(text)) {
		if (isOneShot) {
			if (event.type === "text") {
				lastText = event.content;
			}
			if (event.type === "final") {
				finalText = event.content;
			}
			continue;
		}
		const lines = renderEvent(event);
		for (const line of lines) {
			console.log(line);
		}
	}
	if (isOneShot) {
		const output = finalText || lastText;
		if (output) {
			console.log(output);
		}
	}
};

const createAgentInstance = async (
	tools: Tool[],
	systemPrompt: string,
	toolOutputCacheStore: ToolOutputCacheStore,
	modelOverride?: string,
): Promise<{ agent: Agent; modelConfig: ModelConfig }> => {
	const modelConfig = await resolveModelConfig();
	const selected = modelOverride
		? resolveModelSelection(modelOverride, modelConfig.provider ?? "openai")
		: null;
	const provider = selected?.provider ?? modelConfig.provider ?? "openai";
	const selectedModelName = selected?.name ?? modelConfig.name;
	let llm: BaseChatModel;
	switch (provider) {
		case "openai": {
			const apiKey = readEnvValue("OPENAI_API_KEY");
			if (!apiKey) {
				throw new Error("OPENAI_API_KEY is not set.");
			}
			const reasoningEffort = resolveReasoningEffort(modelConfig.reasoning);
			llm = new ChatOpenAI({
				clientOptions: { apiKey },
				...(selectedModelName ? { model: selectedModelName } : {}),
				...(reasoningEffort ? { reasoningEffort } : {}),
			});
			break;
		}
		case "anthropic": {
			const apiKey = readEnvValue("ANTHROPIC_API_KEY");
			if (!apiKey) {
				throw new Error("ANTHROPIC_API_KEY is not set.");
			}
			llm = new ChatAnthropic({
				clientOptions: { apiKey },
				...(selectedModelName ? { model: selectedModelName } : {}),
			});
			break;
		}
		default:
			throw new Error(`Unsupported model.provider: ${provider}`);
	}
	const modelRegistry = await buildModelRegistry(llm);
	return {
		agent: new Agent({
			llm,
			tools,
			systemPrompt,
			modelRegistry,
			compaction: null,
			services: { toolOutputCacheStore },
		}),
		modelConfig: {
			...modelConfig,
			provider,
			name: selectedModelName,
		},
	};
};

export const runBasicCli = async (): Promise<void> => {
	const args = process.argv.slice(2);
	const { prompt, promptIndex, isOneShot, modelOverride } = parseCliArgs(args);
	if (promptIndex >= 0 && !prompt) {
		console.error("Prompt is required after -p/--prompt.");
		process.exit(1);
	}

	const rootDir = process.env.CODELIA_SANDBOX_ROOT;
	const ctx = await SandboxContext.create(rootDir);
	if (!isOneShot) {
		console.log(`Sandbox created at: ${ctx.rootDir}`);
	}

	const sandboxKey = createSandboxKey(ctx);
	const toolOutputCacheStore = new ToolOutputCacheStoreImpl();
	const tools = createTools(sandboxKey, toolOutputCacheStore);

	const systemPrompt = await loadSystemPrompt(ctx.workingDir);
	let agent: Agent;
	let currentModelConfig: ModelConfig;
	const refreshAgent = async (): Promise<void> => {
		const built = await createAgentInstance(
			tools,
			systemPrompt,
			toolOutputCacheStore,
			modelOverride,
		);
		agent = built.agent;
		currentModelConfig = built.modelConfig;
	};

	try {
		await refreshAgent();
	} catch (error) {
		console.error(describeError(error));
		process.exit(1);
	}

	const runPrompt = async (text: string): Promise<void> =>
		runAgentPrompt(agent, text, isOneShot);

	const handleSlashCommand = async (line: string): Promise<boolean> => {
		if (!line.startsWith("/")) return false;
		const [command, ...args] = line.slice(1).trim().split(/\s+/);
		if (!command) return true;
		if (command === "usage") {
			console.log(formatUsageSummary(agent.getUsageSummary()));
			return true;
		}
		if (command === "model") {
			const targetModel = args[0];
			if (!targetModel) {
				const provider = currentModelConfig.provider ?? "openai";
				const name = currentModelConfig.name ?? "(default)";
				const reasoning = currentModelConfig.reasoning ?? "default";
				console.log(`${provider}/${name} (reasoning: ${reasoning})`);
				return true;
			}
			try {
				const selected = resolveModelSelection(
					targetModel,
					currentModelConfig.provider ?? "openai",
				);
				const configPath = resolveConfigPath();
				await updateModelConfig(configPath, {
					provider: selected.provider,
					name: selected.name,
				});
				await refreshAgent();
				console.log(`Switched model to ${currentModelConfig.name}`);
			} catch (error) {
				console.error(describeError(error));
			}
			return true;
		}
		console.log(`Unknown command: /${command}`);
		return true;
	};

	if (prompt) {
		if (!(await handleSlashCommand(prompt))) {
			await runPrompt(prompt);
		}
		return;
	}

	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	console.log("Enter a prompt (empty line to exit).");

	try {
		while (true) {
			const line = (await rl.question("> ")).trim();
			if (!line) break;
			if (await handleSlashCommand(line)) {
				continue;
			}
			await runPrompt(line);
		}
	} finally {
		rl.close();
	}
};

if (import.meta.main) {
	runBasicCli().catch((error) => {
		console.error(describeError(error));
		process.exit(1);
	});
}
