import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DependencyKey, ToolContext } from "@codelia/core";
import { createSandboxKey, SandboxContext } from "../src/sandbox/context";
import { createGrepTool } from "../src/tools/grep";
import {
	RIPGREP_FALLBACK_REASON,
	type RipgrepLineRunner,
} from "../src/utils/ripgrep";

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

const missingRipgrepRunner: RipgrepLineRunner = async () => ({
	status: "missing",
	error: RIPGREP_FALLBACK_REASON,
});

const malformedRipgrepJsonRunner: RipgrepLineRunner = async (_args, options) => {
	try {
		options.onLine("not-json");
		return {
			status: "ok",
			exitCode: 0,
			stderr: "",
			terminatedEarly: false,
		};
	} catch (error) {
		return {
			status: "error",
			error: `Failed to process ripgrep output: ${String(error)}`,
		};
	}
};

const unreadableRipgrepRunner: RipgrepLineRunner = async (_args, options) => {
	const first = JSON.stringify({
		type: "match",
		data: {
			path: { text: "alpha.txt" },
			lines: { text: "target\n" },
			line_number: 1,
		},
	});
	options.onLine(first);
	return {
		status: "ok",
		exitCode: 2,
		stderr: "",
		terminatedEarly: false,
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
		const longLine = `prefix ${"x".repeat(240)} target`;
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
					limit: 50,
				}),
				createToolContext(),
			);
			expect(result.type).toBe("text");
			if (result.type !== "text") throw new Error("unexpected tool result");
			expect(result.text).toContain("many.txt:1: match 0");
			expect(result.text).toContain("many.txt:50: match 49");
			expect(result.text).not.toContain("many.txt:51: match 50");
			expect(result.text).toContain(
				"Found 60 matching line(s) across 1 file(s); showing first 50:",
			);
			expect(result.text).toContain("... (truncated)");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("uses the default limit of 100 matches when limit is omitted", async () => {
		const tempRoot = await createTempDir();
		const targetFile = path.join(tempRoot, "default-limit.txt");
		const content = Array.from({ length: 120 }, (_, index) => `match ${index}`).join(
			"\n",
		);
		await fs.writeFile(targetFile, content, "utf8");
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const tool = createGrepTool(createSandboxKey(sandbox));
			const result = await tool.executeRaw(
				JSON.stringify({
					path: "default-limit.txt",
					pattern: "match",
				}),
				createToolContext(),
			);
			expect(result.type).toBe("text");
			if (result.type !== "text") throw new Error("unexpected tool result");
			expect(result.text).toContain(
				"Found 120 matching line(s) across 1 file(s); showing first 100:",
			);
			expect(result.text).toContain("default-limit.txt:100: match 99");
			expect(result.text).not.toContain("default-limit.txt:101: match 100");
			expect(result.text).toContain("... (truncated)");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("reports total files across directory matches", async () => {
		const tempRoot = await createTempDir();
		await fs.mkdir(path.join(tempRoot, "nested"), { recursive: true });
		await fs.writeFile(path.join(tempRoot, "alpha.txt"), "target\n", "utf8");
		await fs.writeFile(path.join(tempRoot, "nested", "beta.txt"), "target\n", "utf8");
		await fs.writeFile(path.join(tempRoot, "nested", "gamma.txt"), "miss\n", "utf8");
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const tool = createGrepTool(createSandboxKey(sandbox));
			const result = await tool.executeRaw(
				JSON.stringify({
					pattern: "target",
				}),
				createToolContext(),
			);
			expect(result.type).toBe("text");
			if (result.type !== "text") throw new Error("unexpected tool result");
			expect(result.text).toContain("Found 2 matching line(s) across 2 file(s):");
			expect(result.text).toContain("alpha.txt:1: target");
			expect(result.text).toContain("nested/beta.txt:1: target");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("falls back to the built-in scanner when ripgrep is unavailable", async () => {
		const tempRoot = await createTempDir();
		await fs.mkdir(path.join(tempRoot, "nested"), { recursive: true });
		await fs.writeFile(path.join(tempRoot, "nested", "demo.txt"), "target\n", "utf8");
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const tool = createGrepTool(createSandboxKey(sandbox), {
				runRipgrepLines: missingRipgrepRunner,
			});
			const result = await tool.executeRaw(
				JSON.stringify({
					pattern: "target",
				}),
				createToolContext(),
			);
			expect(result.type).toBe("text");
			if (result.type !== "text") throw new Error("unexpected tool result");
			expect(result.text).toContain("Found 1 matching line(s) across 1 file(s):");
			expect(result.text).toContain("nested/demo.txt:1: target");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("reports invalid regex from the fallback scanner when ripgrep is unavailable", async () => {
		const tempRoot = await createTempDir();
		await fs.writeFile(path.join(tempRoot, "demo.txt"), "target\n", "utf8");
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const tool = createGrepTool(createSandboxKey(sandbox), {
				runRipgrepLines: missingRipgrepRunner,
			});
			const result = await tool.executeRaw(
				JSON.stringify({
					path: "demo.txt",
					pattern: "(",
				}),
				createToolContext(),
			);
			expect(result.type).toBe("text");
			if (result.type !== "text") throw new Error("unexpected tool result");
			expect(result.text).toContain("Invalid regex:");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("surfaces malformed ripgrep json as a tool error", async () => {
		const tempRoot = await createTempDir();
		await fs.writeFile(path.join(tempRoot, "demo.txt"), "target\n", "utf8");
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const tool = createGrepTool(createSandboxKey(sandbox), {
				runRipgrepLines: malformedRipgrepJsonRunner,
			});
			const result = await tool.executeRaw(
				JSON.stringify({
					path: "demo.txt",
					pattern: "target",
				}),
				createToolContext(),
			);
			expect(result.type).toBe("text");
			if (result.type !== "text") throw new Error("unexpected tool result");
			expect(result.text).toContain("Failed to process ripgrep output:");
			expect(result.text).toContain("SyntaxError");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("keeps matches when ripgrep reports unreadable files after streaming results", async () => {
		const tempRoot = await createTempDir();
		await fs.writeFile(path.join(tempRoot, "alpha.txt"), "target\n", "utf8");
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const tool = createGrepTool(createSandboxKey(sandbox), {
				runRipgrepLines: unreadableRipgrepRunner,
			});
			const result = await tool.executeRaw(
				JSON.stringify({
					pattern: "target",
				}),
				createToolContext(),
			);
			expect(result.type).toBe("text");
			if (result.type !== "text") throw new Error("unexpected tool result");
			expect(result.text).toContain("Found 1 matching line(s) across 1 file(s):");
			expect(result.text).toContain("alpha.txt:1: target");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("continues fallback grep past unreadable files", async () => {
		const tempRoot = await createTempDir();
		await fs.mkdir(path.join(tempRoot, "nested"), { recursive: true });
		await fs.writeFile(path.join(tempRoot, "nested", "ok.txt"), "target\n", "utf8");
		await fs.writeFile(path.join(tempRoot, "nested", "blocked.txt"), "target\n", "utf8");
		const blockedPath = path.join(tempRoot, "nested", "blocked.txt");
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const tool = createGrepTool(createSandboxKey(sandbox), {
				runRipgrepLines: missingRipgrepRunner,
				readFile: async (filePath, encoding) => {
					if (filePath === blockedPath) {
						throw new Error("EACCES: permission denied");
					}
					return fs.readFile(filePath, encoding);
				},
			});
			const result = await tool.executeRaw(
				JSON.stringify({
					path: "nested",
					pattern: "target",
				}),
				createToolContext(),
			);
			expect(result.type).toBe("text");
			if (result.type !== "text") throw new Error("unexpected tool result");
			expect(result.text).toContain("Found 1 matching line(s) across 1 file(s):");
			expect(result.text).toContain("ok.txt:1: target");
			expect(result.text).not.toContain("blocked.txt");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});
});
