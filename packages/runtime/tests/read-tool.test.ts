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
	test("clips oversized line by default", async () => {
		const tempRoot = await createTempDir();
		const targetFile = path.join(tempRoot, "long.txt");
		await fs.writeFile(targetFile, "A".repeat(60_000), "utf8");
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const tool = createReadTool(createSandboxKey(sandbox));
			const result = await tool.executeRaw(
				JSON.stringify({ file_path: "long.txt", offset: 0, limit: 1 }),
				createToolContext(),
			);
			expect(result.type).toBe("text");
			if (result.type !== "text") throw new Error("unexpected tool result");
			expect(result.text).toContain(`${"A".repeat(1_000)}...`);
			expect(result.text).toContain("[truncated lines: 1]");
			expect(result.text).toContain("read_line");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("truncates when response exceeds byte cap", async () => {
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
			expect(result.text).toContain("[output truncated at 65536 bytes]");
			expect(result.text).toContain("Use offset to read beyond line");
			expect(Buffer.byteLength(result.text, "utf8")).toBeLessThan(90 * 1024);
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("byte-heavy first line still returns usable clipped output", async () => {
		const tempRoot = await createTempDir();
		const targetFile = path.join(tempRoot, "ja-long.txt");
		await fs.writeFile(targetFile, "あ".repeat(50_000), "utf8");
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const tool = createReadTool(createSandboxKey(sandbox));
			const result = await tool.executeRaw(
				JSON.stringify({
					file_path: "ja-long.txt",
					offset: 0,
					limit: 1,
				}),
				createToolContext(),
			);
			expect(result.type).toBe("text");
			if (result.type !== "text") throw new Error("unexpected tool result");
			expect(result.text).toContain("    1  ");
			expect(result.text).toContain("[truncated lines: 1]");
			expect(result.text).not.toContain("line 0");
			expect(result.text).toContain("read_line");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("escapes file_path in read_line follow-up hints", async () => {
		const tempRoot = await createTempDir();
		const fileName = 'quote"slash\\long.txt';
		const targetFile = path.join(tempRoot, fileName);
		await fs.writeFile(targetFile, "A".repeat(60_000), "utf8");
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const tool = createReadTool(createSandboxKey(sandbox));
			const result = await tool.executeRaw(
				JSON.stringify({ file_path: fileName, offset: 0, limit: 1 }),
				createToolContext(),
			);
			expect(result.type).toBe("text");
			if (result.type !== "text") throw new Error("unexpected tool result");
			expect(result.text).toContain(
				`read_line({"file_path":${JSON.stringify(fileName)},"line_number":1,"char_offset":0,"char_limit":10000})`,
			);
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("full-access allows reading outside the sandbox root", async () => {
		const tempRoot = await createTempDir();
		const outsideRoot = await createTempDir();
		const outsideFile = path.join(outsideRoot, "outside.txt");
		await fs.writeFile(outsideFile, "outside access", "utf8");
		try {
			const sandbox = await SandboxContext.create(tempRoot, {
				approvalMode: "full-access",
			});
			const tool = createReadTool(createSandboxKey(sandbox));
			const result = await tool.executeRaw(
				JSON.stringify({ file_path: outsideFile }),
				createToolContext(),
			);
			expect(result.type).toBe("text");
			if (result.type !== "text") throw new Error("unexpected tool result");
			expect(result.text).toContain("outside access");
			expect(result.text).not.toContain("Security error");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
			await fs.rm(outsideRoot, { recursive: true, force: true });
		}
	});

	test("read throws when path escapes sandbox", async () => {
		const tempRoot = await createTempDir();
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const tool = createReadTool(createSandboxKey(sandbox));
			await expect(
				tool.executeRaw(
					JSON.stringify({ file_path: "../outside.txt" }),
					createToolContext(),
				),
			).rejects.toThrow("Security error");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});
});
