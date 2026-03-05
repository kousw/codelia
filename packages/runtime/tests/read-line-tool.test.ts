import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DependencyKey, ToolContext } from "@codelia/core";
import { createSandboxKey, SandboxContext } from "../src/sandbox/context";
import { createReadLineTool } from "../src/tools/read-line";

const createTempDir = async (): Promise<string> =>
	fs.mkdtemp(path.join(os.tmpdir(), "codelia-read-line-tool-"));

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

describe("read_line tool", () => {
	test("paginates a long single line with char_offset", async () => {
		const tempRoot = await createTempDir();
		const targetFile = path.join(tempRoot, "long.txt");
		await fs.writeFile(targetFile, "A".repeat(25_000), "utf8");
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const tool = createReadLineTool(createSandboxKey(sandbox));
			const first = await tool.executeRaw(
				JSON.stringify({
					file_path: "long.txt",
					line_number: 1,
					char_offset: 0,
					char_limit: 10_000,
				}),
				createToolContext(),
			);
			expect(first.type).toBe("text");
			if (first.type !== "text") throw new Error("unexpected tool result");
			expect(first.text).toContain("line_number=1");
			expect(first.text).toContain("char_range=0..9999");
			expect(first.text).toContain("Use char_offset=10000 to continue.");

			const third = await tool.executeRaw(
				JSON.stringify({
					file_path: "long.txt",
					line_number: 1,
					char_offset: 20_000,
					char_limit: 10_000,
				}),
				createToolContext(),
			);
			expect(third.type).toBe("text");
			if (third.type !== "text") throw new Error("unexpected tool result");
			expect(third.text).toContain("char_range=20000..24999");
			expect(third.text).not.toContain("Use char_offset=");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});
});
