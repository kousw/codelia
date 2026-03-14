import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DependencyKey, ToolContext } from "@codelia/core";
import { createSandboxKey, SandboxContext } from "../src/sandbox/context";
import { createGrepTool } from "../src/tools/grep";

const createTempDir = async (): Promise<string> =>
	fs.mkdtemp(path.join(os.tmpdir(), "codelia-grep-tool-"));

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

describe("grep tool", () => {
	test("directory searches format matches relative to the requested root", async () => {
		const tempRoot = await createTempDir();
		const outsideRoot = await createTempDir();
		const targetFile = path.join(outsideRoot, "src", "main.ts");
		await fs.mkdir(path.dirname(targetFile), { recursive: true });
		await fs.writeFile(targetFile, "export const value = 1;\n", "utf8");
		try {
			const sandbox = await SandboxContext.create(tempRoot, {
				approvalMode: "full-access",
			});
			const tool = createGrepTool(createSandboxKey(sandbox));
			const result = await tool.executeRaw(
				JSON.stringify({
					path: outsideRoot,
					pattern: "value",
				}),
				createToolContext(),
			);
			expect(result.type).toBe("text");
			if (result.type !== "text") throw new Error("unexpected tool result");
			expect(result.text).toContain("src/main.ts:1: export const value = 1;");
			expect(result.text).not.toContain("../");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
			await fs.rm(outsideRoot, { recursive: true, force: true });
		}
	});

	test("explicitly marks truncated matching lines", async () => {
		const tempRoot = await createTempDir();
		const targetFile = path.join(tempRoot, "demo.txt");
		const longLine = `prefix ${"x".repeat(140)} target`;
		await fs.writeFile(targetFile, `${longLine}\n`, "utf8");
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const tool = createGrepTool(createSandboxKey(sandbox));
			const result = await tool.executeRaw(
				JSON.stringify({
					path: "demo.txt",
					pattern: "target",
				}),
				createToolContext(),
			);
			expect(result.type).toBe("text");
			if (result.type !== "text") throw new Error("unexpected tool result");
			expect(result.text).toContain("demo.txt:1: ");
			expect(result.text).toContain("... [line truncated]");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("marks result truncation after the first 50 matches", async () => {
		const tempRoot = await createTempDir();
		const targetFile = path.join(tempRoot, "many.txt");
		const content = Array.from({ length: 60 }, (_, index) => `match ${index}`).join(
			"\n",
		);
		await fs.writeFile(targetFile, content, "utf8");
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const tool = createGrepTool(createSandboxKey(sandbox));
			const result = await tool.executeRaw(
				JSON.stringify({
					path: "many.txt",
					pattern: "match",
				}),
				createToolContext(),
			);
			expect(result.type).toBe("text");
			if (result.type !== "text") throw new Error("unexpected tool result");
			expect(result.text).toContain("many.txt:1: match 0");
			expect(result.text).toContain("many.txt:50: match 49");
			expect(result.text).not.toContain("many.txt:51: match 50");
			expect(result.text).toContain(
				"... (truncated, showing first 50 matches)",
			);
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});
});
