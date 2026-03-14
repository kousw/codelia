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
import { createApplyPatchTool } from "../src/tools/apply-patch";

const createTempDir = async (): Promise<string> =>
	fs.mkdtemp(path.join(os.tmpdir(), "codelia-apply-patch-tool-"));

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

const createMockOutputCacheStore = (
	id: string,
): {
	store: ToolOutputCacheStore;
	getSavedRecord: () => ToolOutputCacheRecord | null;
} => {
	let savedRecord: ToolOutputCacheRecord | null = null;
	return {
		store: {
			save: async (record: ToolOutputCacheRecord): Promise<ToolOutputRef> => {
				savedRecord = record;
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

describe("apply_patch tool", () => {
	test("applies add, update, and delete changes", async () => {
		const tempRoot = await createTempDir();
		try {
			await fs.writeFile(
				path.join(tempRoot, "edit.txt"),
				"alpha\nbeta\ngamma\n",
			);
			await fs.writeFile(path.join(tempRoot, "remove.txt"), "delete me\n");
			const sandbox = await SandboxContext.create(tempRoot);
			const tool = createApplyPatchTool(createSandboxKey(sandbox));
			const patch = [
				"*** Begin Patch",
				"*** Update File: edit.txt",
				"@@",
				" alpha",
				"-beta",
				"+delta",
				" gamma",
				"*** Add File: added.txt",
				"+hello",
				"*** Delete File: remove.txt",
				"*** End Patch",
			].join("\n");
			const result = await tool.executeRaw(
				JSON.stringify({ patch }),
				createToolContext(),
			);
			expect(result.type).toBe("json");
			if (result.type !== "json") {
				throw new Error("unexpected result type");
			}
			const value = result.value as {
				summary: string;
				file_count: number;
				files: Array<{ summary: string }>;
				diff: string;
			};
			expect(value.summary).toBe("Applied patch to 3 file(s)");
			expect(value.file_count).toBe(3);
			expect(value.files.map((entry) => entry.summary)).toEqual([
				"M edit.txt",
				"A added.txt",
				"D remove.txt",
			]);
			expect(value.diff).toContain("--- edit.txt");
			expect(value.diff).toContain("+++ edit.txt");
			expect(value.diff).toContain("+delta");
			expect(value.diff).toContain("--- added.txt");
			expect(value.diff).toContain("--- remove.txt");

			expect(await fs.readFile(path.join(tempRoot, "edit.txt"), "utf8")).toBe(
				"alpha\ndelta\ngamma\n",
			);
			expect(await fs.readFile(path.join(tempRoot, "added.txt"), "utf8")).toBe(
				"hello\n",
			);
			await expect(
				fs.readFile(path.join(tempRoot, "remove.txt"), "utf8"),
			).rejects.toThrow();
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("dry_run previews a move without writing files", async () => {
		const tempRoot = await createTempDir();
		try {
			await fs.writeFile(path.join(tempRoot, "old.txt"), "old value\n");
			const sandbox = await SandboxContext.create(tempRoot);
			const tool = createApplyPatchTool(createSandboxKey(sandbox));
			const patch = [
				"*** Begin Patch",
				"*** Update File: old.txt",
				"*** Move to: new.txt",
				"@@",
				"-old value",
				"+new value",
				"*** End Patch",
			].join("\n");
			const result = await tool.executeRaw(
				JSON.stringify({ patch, dry_run: true }),
				createToolContext(),
			);
			expect(result.type).toBe("json");
			if (result.type !== "json") {
				throw new Error("unexpected result type");
			}
			const value = result.value as {
				summary: string;
				files: Array<{ summary: string }>;
				diff: string;
			};
			expect(value.summary).toBe("Patch preview ready for 1 file(s)");
			expect(value.files[0]?.summary).toBe("R old.txt -> new.txt");
			expect(value.diff).toContain("--- old.txt");
			expect(value.diff).toContain("+++ new.txt");
			expect(await fs.readFile(path.join(tempRoot, "old.txt"), "utf8")).toBe(
				"old value\n",
			);
			await expect(
				fs.readFile(path.join(tempRoot, "new.txt"), "utf8"),
			).rejects.toThrow();
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("supports insertion-only chunks before later matches", async () => {
		const tempRoot = await createTempDir();
		try {
			await fs.writeFile(
				path.join(tempRoot, "edit.txt"),
				"alpha\nbeta\ngamma\n",
			);
			const sandbox = await SandboxContext.create(tempRoot);
			const tool = createApplyPatchTool(createSandboxKey(sandbox));
			const patch = [
				"*** Begin Patch",
				"*** Update File: edit.txt",
				"@@",
				"+intro",
				"@@",
				" beta",
				"-gamma",
				"+delta",
				"*** End Patch",
			].join("\n");
			await tool.executeRaw(JSON.stringify({ patch }), createToolContext());
			expect(await fs.readFile(path.join(tempRoot, "edit.txt"), "utf8")).toBe(
				"intro\nalpha\nbeta\ndelta\n",
			);
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("supports move-only update sections", async () => {
		const tempRoot = await createTempDir();
		try {
			await fs.writeFile(path.join(tempRoot, "old.txt"), "same\n");
			const sandbox = await SandboxContext.create(tempRoot);
			const tool = createApplyPatchTool(createSandboxKey(sandbox));
			const patch = [
				"*** Begin Patch",
				"*** Update File: old.txt",
				"*** Move to: renamed.txt",
				"*** End Patch",
			].join("\n");
			const result = await tool.executeRaw(
				JSON.stringify({ patch }),
				createToolContext(),
			);
			expect(result.type).toBe("json");
			if (result.type !== "json") {
				throw new Error("unexpected result type");
			}
			const value = result.value as {
				files: Array<{ summary: string }>;
				diff: string;
			};
			expect(value.files[0]?.summary).toBe("R old.txt -> renamed.txt");
			expect(value.diff).toBe("");
			expect(
				await fs.readFile(path.join(tempRoot, "renamed.txt"), "utf8"),
			).toBe("same\n");
			await expect(
				fs.readFile(path.join(tempRoot, "old.txt"), "utf8"),
			).rejects.toThrow();
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("allows moving into a path vacated earlier in the same patch", async () => {
		const tempRoot = await createTempDir();
		try {
			await fs.writeFile(path.join(tempRoot, "a.txt"), "from a\n");
			await fs.writeFile(path.join(tempRoot, "b.txt"), "from b\n");
			const sandbox = await SandboxContext.create(tempRoot);
			const tool = createApplyPatchTool(createSandboxKey(sandbox));
			const patch = [
				"*** Begin Patch",
				"*** Delete File: b.txt",
				"*** Update File: a.txt",
				"*** Move to: b.txt",
				"*** End Patch",
			].join("\n");
			await tool.executeRaw(JSON.stringify({ patch }), createToolContext());
			expect(await fs.readFile(path.join(tempRoot, "b.txt"), "utf8")).toBe(
				"from a\n",
			);
			await expect(
				fs.readFile(path.join(tempRoot, "a.txt"), "utf8"),
			).rejects.toThrow();
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("preserves file mode bits when moving a file", async () => {
		const tempRoot = await createTempDir();
		try {
			const source = path.join(tempRoot, "tool.sh");
			await fs.writeFile(source, "#!/bin/sh\necho ok\n");
			await fs.chmod(source, 0o755);
			const sandbox = await SandboxContext.create(tempRoot);
			const tool = createApplyPatchTool(createSandboxKey(sandbox));
			const patch = [
				"*** Begin Patch",
				"*** Update File: tool.sh",
				"*** Move to: tool2.sh",
				"*** End Patch",
			].join("\n");
			await tool.executeRaw(JSON.stringify({ patch }), createToolContext());
			const moved = await fs.stat(path.join(tempRoot, "tool2.sh"));
			expect(moved.mode & 0o777).toBe(0o755);
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("createTools wires output cache store into apply_patch diff previews", async () => {
		const tempRoot = await createTempDir();
		const outputCache = createMockOutputCacheStore("cached-apply-patch-diff");
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const tools = createTools(
				createSandboxKey(sandbox),
				{ id: "agents-test", create: async () => ({}) as never },
				{ id: "skills-test", create: async () => ({}) as never },
				{ toolOutputCacheStore: outputCache.store },
			);
			const tool = requireTool(tools, "apply_patch");
			const patch = [
				"*** Begin Patch",
				"*** Add File: huge.txt",
				...Array.from({ length: 260 }, (_value, index) => {
					return `+line ${String(index).padStart(3, "0")} ${"x".repeat(80)}`;
				}),
				"*** End Patch",
			].join("\n");
			const result = await tool.executeRaw(
				JSON.stringify({ patch }),
				createToolContext(),
			);
			expect(result.type).toBe("json");
			if (result.type !== "json") {
				throw new Error("unexpected result type");
			}
			const value = result.value as {
				diff: string;
				diff_truncated?: boolean;
				diff_cache_id?: string;
			};
			expect(value.diff_truncated).toBe(true);
			expect(value.diff_cache_id).toBe("cached-apply-patch-diff");
			expect(value.diff).toContain("lines omitted");
			expect(outputCache.getSavedRecord()?.tool_name).toBe("apply_patch");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});
});
