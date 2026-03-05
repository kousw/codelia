import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DependencyKey, ToolContext } from "@codelia/core";
import { createSandboxKey, SandboxContext } from "../src/sandbox/context";
import { createReadTool } from "../src/tools/read";

const createTempDir = async (): Promise<string> =>
	fs.mkdtemp(path.join(os.tmpdir(), "codelia-read-tool-"));

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

describe("read tool", () => {
	test("default view clips long lines and explains wrap option", async () => {
		const tempRoot = await createTempDir();
		const targetFile = path.join(tempRoot, "long.txt");
		await fs.writeFile(targetFile, "A".repeat(4500), "utf8");
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const tool = createReadTool(createSandboxKey(sandbox));
			const result = await tool.executeRaw(
				JSON.stringify({ file_path: "long.txt", offset: 0, limit: 1 }),
				createToolContext(),
			);
			expect(result.type).toBe("text");
			if (result.type !== "text") throw new Error("unexpected tool result");
			expect(result.text).toContain(`${"A".repeat(2000)}...`);
			expect(result.text).toContain(
				"Long physical lines are clipped at 2000 chars. Set wrap_long_lines=true to paginate full lines.",
			);
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("read byte cap includes numbered line overhead", async () => {
		const tempRoot = await createTempDir();
		const targetFile = path.join(tempRoot, "many-lines.txt");
		await fs.writeFile(
			targetFile,
			Array.from({ length: 70_000 }, () => "").join("\n"),
			"utf8",
		);
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const tool = createReadTool(createSandboxKey(sandbox));
			const result = await tool.executeRaw(
				JSON.stringify({
					file_path: "many-lines.txt",
					offset: 0,
					limit: 70_000,
				}),
				createToolContext(),
			);
			expect(result.type).toBe("text");
			if (result.type !== "text") throw new Error("unexpected tool result");
			expect(result.text).toContain("Output truncated at 51200 bytes.");
			expect(Buffer.byteLength(result.text, "utf8")).toBeLessThan(60 * 1024);
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("wrap_long_lines paginates very long single-line output", async () => {
		const tempRoot = await createTempDir();
		const targetFile = path.join(tempRoot, "long.txt");
		await fs.writeFile(targetFile, "A".repeat(4500), "utf8");
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const tool = createReadTool(createSandboxKey(sandbox));
			const first = await tool.executeRaw(
				JSON.stringify({
					file_path: "long.txt",
					offset: 0,
					limit: 1,
					wrap_long_lines: true,
				}),
				createToolContext(),
			);
			expect(first.type).toBe("text");
			if (first.type !== "text") throw new Error("unexpected tool result");
			expect(first.text).toContain("Use offset to read beyond line 1.");
			expect(first.text).toContain(`${"A".repeat(2000)}`);
			expect(first.text).toContain(
				"Long physical lines are wrapped at 2000 chars per display line.",
			);

			const third = await tool.executeRaw(
				JSON.stringify({
					file_path: "long.txt",
					offset: 2,
					limit: 1,
					wrap_long_lines: true,
				}),
				createToolContext(),
			);
			expect(third.type).toBe("text");
			if (third.type !== "text") throw new Error("unexpected tool result");
			expect(third.text).toContain(`${"A".repeat(500)}`);
			expect(third.text).not.toContain("Use offset to read beyond line 3.");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});
});
