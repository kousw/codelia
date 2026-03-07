import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveStoragePaths, ToolOutputCacheStoreImpl } from "../src";

describe("@codelia/storage ToolOutputCacheStoreImpl", () => {
	test("read clips oversized line by default", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "codelia-cache-"));
		try {
			const paths = resolveStoragePaths({ rootOverride: root });
			const store = new ToolOutputCacheStoreImpl({ paths });
			const ref = await store.save({
				tool_call_id: "call_long_line",
				tool_name: "bash",
				content: "A".repeat(60_000),
			});
			const output = await store.read(ref.id, { offset: 0, limit: 1 });
			expect(output).toContain(`${"A".repeat(1_000)}...`);
			expect(output).toContain("[truncated lines: 1]");
			expect(output).toContain("tool_output_cache_line");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("readLine paginates long single line by char offset", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "codelia-cache-"));
		try {
			const paths = resolveStoragePaths({ rootOverride: root });
			const store = new ToolOutputCacheStoreImpl({ paths });
			const ref = await store.save({
				tool_call_id: "call_line_paging",
				tool_name: "bash",
				content: "A".repeat(25_000),
			});

			const first = await store.readLine(ref.id, {
				line_number: 1,
				char_offset: 0,
				char_limit: 10_000,
			});
			expect(first).toContain("line_number=1");
			expect(first).toContain("char_range=0..9999");
			expect(first).toContain("Use char_offset=10000 to continue.");

			const last = await store.readLine(ref.id, {
				line_number: 1,
				char_offset: 20_000,
				char_limit: 10_000,
			});
			expect(last).toContain("char_range=20000..24999");
			expect(last).not.toContain("Use char_offset=");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("read returns usable first line for multibyte long line", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "codelia-cache-"));
		try {
			const paths = resolveStoragePaths({ rootOverride: root });
			const store = new ToolOutputCacheStoreImpl({ paths });
			const ref = await store.save({
				tool_call_id: "call_ja_long_line_allow",
				tool_name: "bash",
				content: "あ".repeat(50_000),
			});
			const output = await store.read(ref.id, {
				offset: 0,
				limit: 1,
			});
			expect(output).toContain("    1  ");
			expect(output).toContain("[truncated lines: 1]");
			expect(output).not.toContain("line 0");
			expect(output).toContain("tool_output_cache_line");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("read truncates when default output exceeds byte cap", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "codelia-cache-"));
		try {
			const paths = resolveStoragePaths({ rootOverride: root });
			const store = new ToolOutputCacheStoreImpl({ paths });
			const content = Array.from({ length: 70_000 }, () => "").join("\n");
			const ref = await store.save({
				tool_call_id: "call_read_cap",
				tool_name: "bash",
				content,
			});

			const output = await store.read(ref.id, { offset: 0, limit: 70_000 });
			expect(output).toContain("[output truncated at 65536 bytes]");
			expect(output).toContain("Use offset to read beyond line");
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
			expect(output).toContain("MATCH_TOO_LARGE_TO_RENDER");
			expect(output).toContain("tool_output_cache_line");
			expect(output).toContain("line 61");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
