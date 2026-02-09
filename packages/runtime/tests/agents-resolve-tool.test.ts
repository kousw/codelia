import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DependencyKey, ToolContext } from "@codelia/core";
import { AgentsResolver, createAgentsResolverKey } from "../src/agents";
import { createSandboxKey, SandboxContext } from "../src/sandbox/context";
import { createAgentsResolveTool } from "../src/tools/agents-resolve";

const createTempDir = async (): Promise<string> =>
	fs.mkdtemp(path.join(os.tmpdir(), "codelia-agents-tool-"));

const writeText = async (
	targetPath: string,
	content: string,
): Promise<void> => {
	await fs.mkdir(path.dirname(targetPath), { recursive: true });
	await fs.writeFile(targetPath, content, "utf8");
};

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

describe("agents_resolve tool", () => {
	test("returns newly discovered AGENTS paths for a target scope", async () => {
		const tempRoot = await createTempDir();
		const repoDir = path.join(tempRoot, "repo");
		const targetPath = path.join(repoDir, "src", "feature", "index.ts");
		const nestedAgentsPath = path.join(repoDir, "src", "feature", "AGENTS.md");
		await writeText(path.join(repoDir, ".git"), "");
		await writeText(path.join(repoDir, "AGENTS.md"), "root instructions\n");
		await writeText(nestedAgentsPath, "feature instructions\n");
		await writeText(targetPath, "export const value = 1;\n");

		try {
			const resolver = await AgentsResolver.create(repoDir, undefined, {
				...process.env,
				CODELIA_AGENTS_MARKERS: ".git",
			});
			const sandbox = await SandboxContext.create(repoDir);
			const tool = createAgentsResolveTool(
				createSandboxKey(sandbox),
				createAgentsResolverKey(resolver),
			);
			const context = createToolContext();

			const first = await tool.executeRaw(
				JSON.stringify({ path: "src/feature/index.ts" }),
				context,
			);
			expect(first.type).toBe("json");
			if (first.type !== "json") {
				throw new Error("unexpected tool result");
			}
			const firstValue = first.value as {
				count: number;
				files: Array<{
					path: string;
					reason: string;
					mtime_ms: number;
					size_bytes: number;
				}>;
			};
			expect(firstValue.count).toBe(1);
			expect(firstValue.files[0]).toMatchObject({
				path: nestedAgentsPath,
				reason: "new",
			});

			const second = await tool.executeRaw(
				JSON.stringify({ path: "src/feature/index.ts" }),
				context,
			);
			expect(second.type).toBe("json");
			if (second.type !== "json") {
				throw new Error("unexpected tool result");
			}
			const secondValue = second.value as { count: number };
			expect(secondValue.count).toBe(0);
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("returns security error when path escapes sandbox", async () => {
		const tempRoot = await createTempDir();
		const repoDir = path.join(tempRoot, "repo");
		await fs.mkdir(repoDir, { recursive: true });
		try {
			const resolver = await AgentsResolver.create(repoDir);
			const sandbox = await SandboxContext.create(repoDir);
			const tool = createAgentsResolveTool(
				createSandboxKey(sandbox),
				createAgentsResolverKey(resolver),
			);
			const context = createToolContext();
			const result = await tool.executeRaw(
				JSON.stringify({ path: "../outside.txt" }),
				context,
			);
			expect(result.type).toBe("text");
			if (result.type !== "text") {
				throw new Error("unexpected tool result");
			}
			expect(result.text).toContain("Security error");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});
});
