import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveStoragePaths, ToolOutputCacheStoreImpl } from "../src";

describe("@codelia/storage ToolOutputCacheStoreImpl", () => {
	test("read paginates a huge single physical line as wrapped display lines", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "codelia-cache-"));
		try {
			const paths = resolveStoragePaths({ rootOverride: root });
			const store = new ToolOutputCacheStoreImpl({ paths });
			const longLine = "A".repeat(4_500);
			const ref = await store.save({
				tool_call_id: "call_long_line",
				tool_name: "bash",
				content: longLine,
			});
			expect(ref.line_count).toBe(1);

			const clipped = await store.read(ref.id, { offset: 0, limit: 1 });
			expect(clipped).toContain(`${"A".repeat(2_000)}...`);
			expect(clipped).toContain(
				"Long physical lines are clipped at 2000 chars. Set wrap_long_lines=true to paginate full lines.",
			);

			const first = await store.read(ref.id, {
				offset: 0,
				limit: 1,
				wrap_long_lines: true,
			});
			expect(first).toContain(`${"A".repeat(2_000)}`);
			expect(first).toContain("Use offset to read beyond line 1.");
			expect(first).toContain(
				"Long physical lines are wrapped at 2000 chars per display line.",
			);

			const second = await store.read(ref.id, {
				offset: 1,
				limit: 1,
				wrap_long_lines: true,
			});
			expect(second).toContain("Use offset to read beyond line 2.");
			expect(second).toContain(`${"A".repeat(2_000)}`);

			const third = await store.read(ref.id, {
				offset: 2,
				limit: 1,
				wrap_long_lines: true,
			});
			expect(third).toContain(`${"A".repeat(500)}`);
			expect(third).not.toContain("Use offset to read beyond line 3.");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("read caps output bytes and returns continuation hint", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "codelia-cache-"));
		try {
			const paths = resolveStoragePaths({ rootOverride: root });
			const store = new ToolOutputCacheStoreImpl({ paths });
			const content = Array.from({ length: 80 }, () => "B".repeat(2_000)).join(
				"\n",
			);
			const ref = await store.save({
				tool_call_id: "call_read_cap",
				tool_name: "bash",
				content,
			});

			const output = await store.read(ref.id, { offset: 0, limit: 80 });
			expect(output).toContain("Output truncated at 51200 bytes.");
			expect(output).toContain("Use offset to read beyond line");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("read byte cap includes numbered line overhead", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "codelia-cache-"));
		try {
			const paths = resolveStoragePaths({ rootOverride: root });
			const store = new ToolOutputCacheStoreImpl({ paths });
			const content = Array.from({ length: 70_000 }, () => "").join("\n");
			const ref = await store.save({
				tool_call_id: "call_numbered_cap",
				tool_name: "bash",
				content,
			});

			const output = await store.read(ref.id, { offset: 0, limit: 70_000 });
			expect(output).toContain("Output truncated at 51200 bytes.");
			expect(Buffer.byteLength(output, "utf8")).toBeLessThan(60 * 1024);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("grep keeps huge matches bounded", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "codelia-cache-"));
		try {
			const paths = resolveStoragePaths({ rootOverride: root });
			const store = new ToolOutputCacheStoreImpl({ paths });
			const lines = Array.from({ length: 120 }, (_, index) => {
				if (index === 60) {
					return `needle-${"X".repeat(3_000)}`;
				}
				return "Y".repeat(3_000);
			}).join("\n");
			const ref = await store.save({
				tool_call_id: "call_grep_cap",
				tool_name: "bash",
				content: lines,
			});

			const output = await store.grep(ref.id, {
				pattern: "needle",
				before: 80,
				after: 80,
			});
			expect(output).toContain(
				"Matches found but output exceeded 51200 bytes.",
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
