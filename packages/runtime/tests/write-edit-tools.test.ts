import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DependencyKey, ToolContext } from "@codelia/core";
import { createSandboxKey, SandboxContext } from "../src/sandbox/context";
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
			expect(result.type).toBe("text");
			if (result.type !== "text") throw new Error("unexpected tool result");
			expect(result.text).toContain("Wrote 11 bytes to nested/notes.txt");

			const written = await fs.readFile(
				path.join(tempRoot, "nested", "notes.txt"),
				"utf8",
			);
			expect(written).toBe("hello world");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("write blocks paths outside sandbox", async () => {
		const tempRoot = await createTempDir();
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const tool = createWriteTool(createSandboxKey(sandbox));
			const result = await tool.executeRaw(
				JSON.stringify({
					file_path: "../outside.txt",
					content: "nope",
				}),
				createToolContext(),
			);
			expect(result.type).toBe("text");
			if (result.type !== "text") throw new Error("unexpected tool result");
			expect(result.text).toContain("Security error");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
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

	test("edit returns error when multiple matches exist without replace_all", async () => {
		const tempRoot = await createTempDir();
		const targetFile = path.join(tempRoot, "multi.txt");
		await fs.writeFile(targetFile, "x x", "utf8");
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const tool = createEditTool(createSandboxKey(sandbox));
			const result = await tool.executeRaw(
				JSON.stringify({
					file_path: "multi.txt",
					old_string: "x",
					new_string: "y",
				}),
				createToolContext(),
			);
			expect(result.type).toBe("text");
			if (result.type !== "text") throw new Error("unexpected tool result");
			expect(result.text).toContain("Multiple matches");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});
});
