import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DependencyKey, ToolContext } from "@codelia/core";
import { createSandboxKey, SandboxContext } from "../src/sandbox/context";
import { createGlobSearchTool } from "../src/tools/glob-search";

const createTempDir = async (): Promise<string> =>
	fs.mkdtemp(path.join(os.tmpdir(), "codelia-glob-tool-"));

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

describe("glob_search tool", () => {
	test("matches patterns relative to the requested directory", async () => {
		const tempRoot = await createTempDir();
		const projectDir = path.join(tempRoot, "project");
		const targetFile = path.join(projectDir, "src", "main.ts");
		await fs.mkdir(path.dirname(targetFile), { recursive: true });
		await fs.writeFile(targetFile, "export {};\n", "utf8");
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const tool = createGlobSearchTool(createSandboxKey(sandbox));
			const result = await tool.executeRaw(
				JSON.stringify({
					path: "project",
					pattern: "src/**/*.ts",
				}),
				createToolContext(),
			);
			expect(result.type).toBe("text");
			if (result.type !== "text") throw new Error("unexpected tool result");
			expect(result.text).toContain("src/main.ts");
			expect(result.text).not.toContain("project/src/main.ts");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("full-access matches requested directories outside the sandbox", async () => {
		const tempRoot = await createTempDir();
		const outsideRoot = await createTempDir();
		const targetFile = path.join(outsideRoot, "src", "main.ts");
		await fs.mkdir(path.dirname(targetFile), { recursive: true });
		await fs.writeFile(targetFile, "export {};\n", "utf8");
		try {
			const sandbox = await SandboxContext.create(tempRoot, {
				approvalMode: "full-access",
			});
			const tool = createGlobSearchTool(createSandboxKey(sandbox));
			const result = await tool.executeRaw(
				JSON.stringify({
					path: outsideRoot,
					pattern: "src/**/*.ts",
				}),
				createToolContext(),
			);
			expect(result.type).toBe("text");
			if (result.type !== "text") throw new Error("unexpected tool result");
			expect(result.text).toContain("src/main.ts");
			expect(result.text).not.toContain("../../");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
			await fs.rm(outsideRoot, { recursive: true, force: true });
		}
	});
});
