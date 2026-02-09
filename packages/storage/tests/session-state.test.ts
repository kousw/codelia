import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SessionState } from "@codelia/core";
import { resolveStoragePaths, SessionStateStoreImpl } from "../src";

describe("@codelia/storage SessionStateStoreImpl", () => {
	test("list returns summary with last user message display formatting", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "codelia-storage-"));
		try {
			const paths = resolveStoragePaths({ rootOverride: root });
			const store = new SessionStateStoreImpl({ paths });
			const state: SessionState = {
				schema_version: 1,
				session_id: "session_1",
				updated_at: "2026-02-08T00:00:00.000Z",
				run_id: "run_1",
				messages: [
					{ role: "system", content: "system" },
					{
						role: "user",
						content: [
							{ type: "text", text: "hello" },
							{
								type: "image_url",
								image_url: { url: "data:image/png;base64,abc" },
							},
							{
								type: "other",
								provider: "custom",
								kind: "blob",
								payload: { sample: true },
							},
						],
					},
				],
			};
			await store.save(state);
			const summaries = await store.list();

			expect(summaries).toHaveLength(1);
			expect(summaries[0]?.session_id).toBe("session_1");
			expect(summaries[0]?.last_user_message).toBe(
				"hello[image][other:custom/blob]",
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("resolveStoragePaths(rootOverride) keeps files under given root", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "codelia-storage-"));
		try {
			const paths = resolveStoragePaths({ rootOverride: root });
			expect(paths.root).toBe(root);
			expect(paths.configFile).toBe(path.join(root, "config.json"));
			expect(paths.sessionsDir).toBe(path.join(root, "sessions"));
			expect(paths.toolOutputCacheDir).toBe(
				path.join(root, "cache", "tool-output"),
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
