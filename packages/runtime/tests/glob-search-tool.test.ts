import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DependencyKey, ToolContext } from "@codelia/core";
import { createSandboxKey, SandboxContext } from "../src/sandbox/context";
import { createGlobSearchTool } from "../src/tools/glob-search";
import {
	RIPGREP_FALLBACK_REASON,
	type RipgrepLineRunner,
} from "../src/utils/ripgrep";

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

const missingRipgrepRunner: RipgrepLineRunner = async () => ({
	status: "missing",
	error: RIPGREP_FALLBACK_REASON,
});

const errorRipgrepRunner: RipgrepLineRunner = async () => ({
	status: "error",
	error: "synthetic ripgrep failure",
});

const sortedRipgrepRunner: RipgrepLineRunner = async (args, options) => {
	expect(args).toContain("--sort");
	expect(args).toContain("path");
	for (const line of ["file-000.ts", "file-001.ts", "file-002.ts"]) {
		options.onLine(line);
	}
	return {
		status: "ok",
		exitCode: 0,
		stderr: "",
		terminatedEarly: false,
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

	test("reports displayed limits truthfully with deterministic ordering", async () => {
		const tempRoot = await createTempDir();
		const projectDir = path.join(tempRoot, "project");
		await fs.mkdir(projectDir, { recursive: true });
		for (let index = 79; index >= 0; index -= 1) {
			await fs.writeFile(
				path.join(projectDir, `file-${String(index).padStart(3, "0")}.ts`),
				"export {};\n",
				"utf8",
			);
		}
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const tool = createGlobSearchTool(createSandboxKey(sandbox));
			const result = await tool.executeRaw(
				JSON.stringify({
					path: "project",
					pattern: "*.ts",
					limit: 50,
				}),
				createToolContext(),
			);
			expect(result.type).toBe("text");
			if (result.type !== "text") throw new Error("unexpected tool result");
			const lines = result.text.split("\n");
			expect(lines[0]).toBe("Found 80 file(s); showing first 50:");
			expect(lines[1]).toBe("file-000.ts");
			expect(lines[50]).toBe("file-049.ts");
			expect(lines.at(-1)).toBe("... (truncated)");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("marks early stop when matches exceed the scan limit", async () => {
		const tempRoot = await createTempDir();
		const projectDir = path.join(tempRoot, "project");
		await fs.mkdir(projectDir, { recursive: true });
		for (let index = 0; index < 205; index += 1) {
			await fs.writeFile(
				path.join(projectDir, `file-${String(index).padStart(3, "0")}.ts`),
				"export {};\n",
				"utf8",
			);
		}
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const tool = createGlobSearchTool(createSandboxKey(sandbox));
			const result = await tool.executeRaw(
				JSON.stringify({
					path: "project",
					pattern: "*.ts",
					limit: 50,
				}),
				createToolContext(),
			);
			expect(result.type).toBe("text");
			if (result.type !== "text") throw new Error("unexpected tool result");
			expect(result.text).toContain(
				"Found more than 200 matching file(s); showing first 50:",
			);
			expect(result.text).toContain("... (truncated, search stopped early)");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("uses the default limit of 100 files when limit is omitted", async () => {
		const tempRoot = await createTempDir();
		const projectDir = path.join(tempRoot, "project");
		await fs.mkdir(projectDir, { recursive: true });
		for (let index = 0; index < 150; index += 1) {
			await fs.writeFile(
				path.join(projectDir, `file-${String(index).padStart(3, "0")}.ts`),
				"export {};\n",
				"utf8",
			);
		}
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const tool = createGlobSearchTool(createSandboxKey(sandbox));
			const result = await tool.executeRaw(
				JSON.stringify({
					path: "project",
					pattern: "*.ts",
				}),
				createToolContext(),
			);
			expect(result.type).toBe("text");
			if (result.type !== "text") throw new Error("unexpected tool result");
			const lines = result.text.split("\n");
			expect(lines[0]).toBe("Found 150 file(s); showing first 100:");
			expect(lines[1]).toBe("file-000.ts");
			expect(lines[100]).toBe("file-099.ts");
			expect(lines.at(-1)).toBe("... (truncated)");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("returns a clear no-match message", async () => {
		const tempRoot = await createTempDir();
		const projectDir = path.join(tempRoot, "project");
		await fs.mkdir(projectDir, { recursive: true });
		await fs.writeFile(path.join(projectDir, "main.ts"), "export {};\n", "utf8");
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const tool = createGlobSearchTool(createSandboxKey(sandbox));
			const result = await tool.executeRaw(
				JSON.stringify({
					path: "project",
					pattern: "*.md",
				}),
				createToolContext(),
			);
			expect(result.type).toBe("text");
			if (result.type !== "text") throw new Error("unexpected tool result");
			expect(result.text).toBe("No files match pattern: *.md");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("falls back to the built-in walker when ripgrep is unavailable", async () => {
		const tempRoot = await createTempDir();
		const projectDir = path.join(tempRoot, "project");
		const targetFile = path.join(projectDir, "nested", "main.ts");
		await fs.mkdir(path.dirname(targetFile), { recursive: true });
		await fs.writeFile(targetFile, "export {};\n", "utf8");
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const tool = createGlobSearchTool(createSandboxKey(sandbox), {
				runRipgrepLines: missingRipgrepRunner,
			});
			const result = await tool.executeRaw(
				JSON.stringify({
					path: "project",
					pattern: "**/*.ts",
				}),
				createToolContext(),
			);
			expect(result.type).toBe("text");
			if (result.type !== "text") throw new Error("unexpected tool result");
			expect(result.text).toContain("Found 1 file(s):");
			expect(result.text).toContain("nested/main.ts");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("surfaces ripgrep backend errors clearly", async () => {
		const tempRoot = await createTempDir();
		const projectDir = path.join(tempRoot, "project");
		await fs.mkdir(projectDir, { recursive: true });
		await fs.writeFile(path.join(projectDir, "main.ts"), "export {};\n", "utf8");
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const tool = createGlobSearchTool(createSandboxKey(sandbox), {
				runRipgrepLines: errorRipgrepRunner,
			});
			const result = await tool.executeRaw(
				JSON.stringify({
					path: "project",
					pattern: "*.ts",
				}),
				createToolContext(),
			);
			expect(result.type).toBe("text");
			if (result.type !== "text") throw new Error("unexpected tool result");
			expect(result.text).toBe("Error searching files: synthetic ripgrep failure");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("requests path-sorted ripgrep output for deterministic first pages", async () => {
		const tempRoot = await createTempDir();
		const projectDir = path.join(tempRoot, "project");
		await fs.mkdir(projectDir, { recursive: true });
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const tool = createGlobSearchTool(createSandboxKey(sandbox), {
				runRipgrepLines: sortedRipgrepRunner,
			});
			const result = await tool.executeRaw(
				JSON.stringify({
					path: "project",
					pattern: "*.ts",
					limit: 2,
				}),
				createToolContext(),
			);
			expect(result.type).toBe("text");
			if (result.type !== "text") throw new Error("unexpected tool result");
			expect(result.text).toContain("Found 3 file(s); showing first 2:");
			expect(result.text).toContain("file-000.ts");
			expect(result.text).toContain("file-001.ts");
			expect(result.text).not.toContain("file-002.ts");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});
});
