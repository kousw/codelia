import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
	DependencyKey,
	Tool,
	ToolContext,
	ToolOutputCacheRecord,
	ToolOutputCacheStore,
	ToolOutputRef,
} from "@codelia/core";
import { createSandboxKey, SandboxContext } from "../src/sandbox/context";
import { createTools } from "../src/tools";
import { createEditTool } from "../src/tools/edit";
import { createWriteTool } from "../src/tools/write";

const createTempDir = async (): Promise<string> =>
	fs.mkdtemp(path.join(os.tmpdir(), "codelia-write-edit-tool-"));

const createToolContext = (): ToolContext => {
	const cache = new Map<string, unknown>();
	const deps: Record<string, unknown> = Object.create(null);
	return {
		deps,
		resolve: async <T>(key: DependencyKey<T>): Promise<T> => {
			if (cache.has(key.id)) {
				return cache.get(key.id) as T;
			}
			const value = await key.create();
			cache.set(key.id, value);
			return value;
		},
	};
};

const createLargeText = (lineCount = 260): string =>
	Array.from(
		{ length: lineCount },
		(_, index) => `line ${String(index).padStart(3, "0")} ${"x".repeat(80)}`,
	).join("\n");

const createMockOutputCacheStore = (
	id: string,
	options: { throwOnSave?: boolean } = {},
): {
	store: ToolOutputCacheStore;
	getSavedRecord: () => ToolOutputCacheRecord | null;
} => {
	let savedRecord: ToolOutputCacheRecord | null = null;
	return {
		store: {
			save: async (record: ToolOutputCacheRecord): Promise<ToolOutputRef> => {
				savedRecord = record;
				if (options.throwOnSave) {
					throw new Error("cache unavailable");
				}
				return {
					id,
					byte_size: Buffer.byteLength(record.content, "utf8"),
					line_count: record.content.split(/\r?\n/).length,
				};
			},
		},
		getSavedRecord: () => savedRecord,
	};
};

const requireTool = (tools: Tool[], name: string): Tool => {
	const tool = tools.find((candidate) => candidate.definition.name === name);
	if (!tool) {
		throw new Error(`tool not found: ${name}`);
	}
	return tool;
};

describe("write/edit tools", () => {
	test("write creates parent directories and writes UTF-8 content", async () => {
		const tempRoot = await createTempDir();
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const tool = createWriteTool(createSandboxKey(sandbox));
			const result = await tool.executeRaw(
				JSON.stringify({
					file_path: "nested/notes.txt",
					content: "hello world",
				}),
				createToolContext(),
			);
			expect(result.type).toBe("json");
			if (result.type !== "json") throw new Error("unexpected tool result");
			const value = result.value as {
				summary: string;
				diff: string;
				file_path: string;
			};
			expect(value.summary).toContain("Wrote 11 bytes to nested/notes.txt");
			expect(value.file_path).toBe("nested/notes.txt");
			expect(value.diff).toContain("--- nested/notes.txt");
			expect(value.diff).toContain("+++ nested/notes.txt");
			expect(value.diff).toContain("+hello world");

			const written = await fs.readFile(
				path.join(tempRoot, "nested", "notes.txt"),
				"utf8",
			);
			expect(written).toBe("hello world");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("write reports accurate diff when overwriting an existing file", async () => {
		const tempRoot = await createTempDir();
		const targetFile = path.join(tempRoot, "overwrite.txt");
		await fs.writeFile(targetFile, "alpha\nbeta\n", "utf8");
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const tool = createWriteTool(createSandboxKey(sandbox));
			const result = await tool.executeRaw(
				JSON.stringify({
					file_path: "overwrite.txt",
					content: "alpha\ngamma\n",
				}),
				createToolContext(),
			);
			expect(result.type).toBe("json");
			if (result.type !== "json") throw new Error("unexpected tool result");
			const value = result.value as { diff: string };
			expect(value.diff).toContain("-beta");
			expect(value.diff).toContain("+gamma");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("write reports UTF-8 byte counts for multibyte content", async () => {
		const tempRoot = await createTempDir();
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const tool = createWriteTool(createSandboxKey(sandbox));
			const result = await tool.executeRaw(
				JSON.stringify({
					file_path: "utf8.txt",
					content: "あ",
				}),
				createToolContext(),
			);
			expect(result.type).toBe("json");
			if (result.type !== "json") throw new Error("unexpected tool result");
			const value = result.value as { summary: string };
			expect(value.summary).toContain("Wrote 3 bytes to utf8.txt");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("createTools wires output cache store into write diff previews", async () => {
		const tempRoot = await createTempDir();
		const largeText = createLargeText();
		const outputCache = createMockOutputCacheStore("cached-write-diff");
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const tools = createTools(
				createSandboxKey(sandbox),
				{ id: "agents-test", create: async () => ({}) as never },
				{ id: "skills-test", create: async () => ({}) as never },
				{ toolOutputCacheStore: outputCache.store },
			);
			const tool = requireTool(tools, "write");
			const result = await tool.executeRaw(
				JSON.stringify({
					file_path: "big.txt",
					content: largeText,
				}),
				createToolContext(),
			);
			expect(result.type).toBe("json");
			if (result.type !== "json") throw new Error("unexpected tool result");
			const value = result.value as {
				diff: string;
				diff_truncated?: boolean;
				diff_cache_id?: string;
			};
			expect(value.diff_truncated).toBe(true);
			expect(value.diff_cache_id).toBe("cached-write-diff");
			expect(value.diff).toContain("lines omitted");
			const savedRecord = outputCache.getSavedRecord();
			expect(savedRecord?.tool_name).toBe("write");
			expect(savedRecord?.content.length).toBeGreaterThan(value.diff.length);
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("write still succeeds when diff cache persistence fails", async () => {
		const tempRoot = await createTempDir();
		const largeText = createLargeText();
		const outputCache = createMockOutputCacheStore("cached-write-diff", {
			throwOnSave: true,
		});
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const tools = createTools(
				createSandboxKey(sandbox),
				{ id: "agents-test", create: async () => ({}) as never },
				{ id: "skills-test", create: async () => ({}) as never },
				{ toolOutputCacheStore: outputCache.store },
			);
			const tool = requireTool(tools, "write");
			const result = await tool.executeRaw(
				JSON.stringify({
					file_path: "big-cache-fail.txt",
					content: largeText,
				}),
				createToolContext(),
			);
			expect(result.type).toBe("json");
			if (result.type !== "json") throw new Error("unexpected tool result");
			const value = result.value as {
				summary: string;
				diff: string;
				diff_truncated?: boolean;
				diff_cache_id?: string;
				diff_cache_error?: string;
			};
			expect(value.summary).toContain("Wrote ");
			expect(value.diff_truncated).toBe(true);
			expect(value.diff_cache_id).toBeUndefined();
			expect(value.diff_cache_error).toContain("cache unavailable");
			expect(value.diff).toContain("lines omitted");
			const written = await fs.readFile(
				path.join(tempRoot, "big-cache-fail.txt"),
				"utf8",
			);
			expect(written).toBe(largeText);
			expect(outputCache.getSavedRecord()?.tool_name).toBe("write");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("write blocks paths outside sandbox", async () => {
		const tempRoot = await createTempDir();
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const tool = createWriteTool(createSandboxKey(sandbox));
			await expect(
				tool.executeRaw(
					JSON.stringify({
						file_path: "../outside.txt",
						content: "nope",
					}),
					createToolContext(),
				),
			).rejects.toThrow("Security error");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("write allows paths outside sandbox in full-access mode", async () => {
		const tempRoot = await createTempDir();
		const outsideRoot = await createTempDir();
		const outsidePath = path.join(outsideRoot, "outside.txt");
		try {
			const sandbox = await SandboxContext.create(tempRoot, {
				approvalMode: "full-access",
			});
			const tool = createWriteTool(createSandboxKey(sandbox));
			const result = await tool.executeRaw(
				JSON.stringify({
					file_path: outsidePath,
					content: "allowed",
				}),
				createToolContext(),
			);
			expect(result.type).toBe("json");
			if (result.type !== "json") throw new Error("unexpected tool result");
			const written = await fs.readFile(outsidePath, "utf8");
			expect(written).toBe("allowed");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
			await fs.rm(outsideRoot, { recursive: true, force: true });
		}
	});

	test("edit replaces exact match and persists updated file", async () => {
		const tempRoot = await createTempDir();
		const targetFile = path.join(tempRoot, "demo.txt");
		await fs.writeFile(targetFile, "alpha beta", "utf8");
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const tool = createEditTool(createSandboxKey(sandbox));
			const result = await tool.executeRaw(
				JSON.stringify({
					file_path: "demo.txt",
					old_string: "beta",
					new_string: "gamma",
				}),
				createToolContext(),
			);
			expect(result.type).toBe("json");
			if (result.type !== "json") throw new Error("unexpected tool result");
			const value = result.value as {
				replacements: number;
				match_mode: string;
				summary: string;
			};
			expect(value.replacements).toBe(1);
			expect(value.match_mode).toBe("exact");
			expect(value.summary).toContain("Replaced 1 occurrence(s) in demo.txt");

			const edited = await fs.readFile(targetFile, "utf8");
			expect(edited).toBe("alpha gamma");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("edit dry_run previews diff without writing file", async () => {
		const tempRoot = await createTempDir();
		const targetFile = path.join(tempRoot, "preview.txt");
		await fs.writeFile(targetFile, "before", "utf8");
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const tool = createEditTool(createSandboxKey(sandbox));
			const result = await tool.executeRaw(
				JSON.stringify({
					file_path: "preview.txt",
					old_string: "before",
					new_string: "after",
					dry_run: true,
				}),
				createToolContext(),
			);
			expect(result.type).toBe("json");
			if (result.type !== "json") throw new Error("unexpected tool result");
			const value = result.value as { summary: string; diff: string };
			expect(value.summary).toContain(
				"Preview: 1 replacement(s) in preview.txt",
			);
			expect(value.diff).toContain("-before");
			expect(value.diff).toContain("+after");

			const unchanged = await fs.readFile(targetFile, "utf8");
			expect(unchanged).toBe("before");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("edit stores full diff in output cache when preview is truncated", async () => {
		const tempRoot = await createTempDir();
		const largeText = createLargeText();
		const outputCache = createMockOutputCacheStore("cached-edit-diff");
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const tool = createEditTool(createSandboxKey(sandbox), outputCache.store);
			const result = await tool.executeRaw(
				JSON.stringify({
					file_path: "preview-large.txt",
					old_string: "",
					new_string: largeText,
					dry_run: true,
				}),
				createToolContext(),
			);
			expect(result.type).toBe("json");
			if (result.type !== "json") throw new Error("unexpected tool result");
			const value = result.value as {
				diff: string;
				diff_truncated?: boolean;
				diff_cache_id?: string;
			};
			expect(value.diff_truncated).toBe(true);
			expect(value.diff_cache_id).toBe("cached-edit-diff");
			expect(value.diff).toContain("lines omitted");
			const savedRecord = outputCache.getSavedRecord();
			expect(savedRecord?.tool_name).toBe("edit");
			expect(savedRecord?.content.length).toBeGreaterThan(value.diff.length);
			await expect(
				fs.stat(path.join(tempRoot, "preview-large.txt")),
			).rejects.toThrow();
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("edit preview stays usable when diff cache persistence fails", async () => {
		const tempRoot = await createTempDir();
		const largeText = createLargeText();
		const outputCache = createMockOutputCacheStore("cached-edit-diff", {
			throwOnSave: true,
		});
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const tool = createEditTool(createSandboxKey(sandbox), outputCache.store);
			const result = await tool.executeRaw(
				JSON.stringify({
					file_path: "preview-cache-fail.txt",
					old_string: "",
					new_string: largeText,
					dry_run: true,
				}),
				createToolContext(),
			);
			expect(result.type).toBe("json");
			if (result.type !== "json") throw new Error("unexpected tool result");
			const value = result.value as {
				diff: string;
				diff_truncated?: boolean;
				diff_cache_id?: string;
				diff_cache_error?: string;
			};
			expect(value.diff_truncated).toBe(true);
			expect(value.diff_cache_id).toBeUndefined();
			expect(value.diff_cache_error).toContain("cache unavailable");
			expect(value.diff).toContain("lines omitted");
			expect(outputCache.getSavedRecord()?.tool_name).toBe("edit");
			await expect(
				fs.stat(path.join(tempRoot, "preview-cache-fail.txt")),
			).rejects.toThrow();
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("edit returns error when multiple matches exist without replace_all", async () => {
		const tempRoot = await createTempDir();
		const targetFile = path.join(tempRoot, "multi.txt");
		await fs.writeFile(targetFile, "x x", "utf8");
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const tool = createEditTool(createSandboxKey(sandbox));
			await expect(
				tool.executeRaw(
					JSON.stringify({
						file_path: "multi.txt",
						old_string: "x",
						new_string: "y",
					}),
					createToolContext(),
				),
			).rejects.toThrow("Multiple matches");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("edit throws when old_string is not found", async () => {
		const tempRoot = await createTempDir();
		const targetFile = path.join(tempRoot, "missing.txt");
		await fs.writeFile(targetFile, "alpha beta", "utf8");
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const tool = createEditTool(createSandboxKey(sandbox));
			await expect(
				tool.executeRaw(
					JSON.stringify({
						file_path: "missing.txt",
						old_string: "gamma",
						new_string: "delta",
					}),
					createToolContext(),
				),
			).rejects.toThrow("String not found in missing.txt");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("edit allows paths outside sandbox in full-access mode", async () => {
		const tempRoot = await createTempDir();
		const outsideRoot = await createTempDir();
		const targetFile = path.join(outsideRoot, "outside.txt");
		await fs.writeFile(targetFile, "alpha beta", "utf8");
		try {
			const sandbox = await SandboxContext.create(tempRoot, {
				approvalMode: "full-access",
			});
			const tool = createEditTool(createSandboxKey(sandbox));
			const result = await tool.executeRaw(
				JSON.stringify({
					file_path: targetFile,
					old_string: "beta",
					new_string: "gamma",
				}),
				createToolContext(),
			);
			expect(result.type).toBe("json");
			if (result.type !== "json") throw new Error("unexpected tool result");
			const edited = await fs.readFile(targetFile, "utf8");
			expect(edited).toBe("alpha gamma");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
			await fs.rm(outsideRoot, { recursive: true, force: true });
		}
	});
});
