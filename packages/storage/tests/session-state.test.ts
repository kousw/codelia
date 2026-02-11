import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SessionState } from "@codelia/core";
import { resolveStoragePaths, SessionStateStoreImpl } from "../src";

describe("@codelia/storage SessionStateStoreImpl", () => {
	test("save/load uses indexed state + message JSONL and formats summary", async () => {
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
			const reloaded = await store.load("session_1");
			expect(reloaded).toBeTruthy();
			expect(reloaded?.messages).toEqual(state.messages);

			const messageFilePath = path.join(
				paths.sessionsDir,
				"messages",
				"session_1.jsonl",
			);
			const dbPath = path.join(paths.sessionsDir, "state.db");
			const messageFile = await readFile(messageFilePath, "utf8");
			const dbStat = await Bun.file(dbPath).exists();
			expect(dbStat).toBe(true);
			expect(messageFile.split(/\r?\n/).filter(Boolean).length).toBe(2);

			const summaries = await store.list();
			expect(summaries).toHaveLength(1);
			expect(summaries[0]?.session_id).toBe("session_1");
			expect(summaries[0]?.message_count).toBe(2);
			expect(summaries[0]?.last_user_message).toBe(
				"hello[image][other:custom/blob]",
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("load reads legacy state file and migrates it to indexed/message layout", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "codelia-storage-"));
		try {
			const paths = resolveStoragePaths({ rootOverride: root });
			const store = new SessionStateStoreImpl({ paths });
			const legacyState: SessionState = {
				schema_version: 1,
				session_id: "legacy_1",
				updated_at: "2026-02-08T00:00:00.000Z",
				run_id: "run_legacy",
				invoke_seq: 7,
				messages: [
					{ role: "system", content: "system" },
					{ role: "user", content: "legacy hello" },
				],
			};
			const legacyDir = path.join(paths.sessionsDir, "state");
			await mkdir(legacyDir, { recursive: true });
			const legacyPath = path.join(legacyDir, "legacy_1.json");
			await writeFile(legacyPath, `${JSON.stringify(legacyState)}\n`, "utf8");

			const loaded = await store.load("legacy_1");
			expect(loaded).toEqual(legacyState);

			const migratedMessagePath = path.join(
				paths.sessionsDir,
				"messages",
				"legacy_1.jsonl",
			);
			expect(await Bun.file(migratedMessagePath).exists()).toBe(true);

			await unlink(legacyPath);
			const loadedAfterLegacyRemoval = await store.load("legacy_1");
			expect(loadedAfterLegacyRemoval).toEqual(legacyState);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("list merges indexed sessions with remaining legacy sessions", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "codelia-storage-"));
		try {
			const paths = resolveStoragePaths({ rootOverride: root });
			const store = new SessionStateStoreImpl({ paths });

			await store.save({
				schema_version: 1,
				session_id: "indexed_session",
				updated_at: "2026-02-08T01:00:00.000Z",
				run_id: "run_indexed",
				messages: [{ role: "user", content: "indexed" }],
			});

			const legacyDir = path.join(paths.sessionsDir, "state");
			await mkdir(legacyDir, { recursive: true });
			await writeFile(
				path.join(legacyDir, "legacy_session.json"),
				`${JSON.stringify({
					schema_version: 1,
					session_id: "legacy_session",
					updated_at: "2026-02-08T00:30:00.000Z",
					run_id: "run_legacy",
					messages: [{ role: "user", content: "legacy" }],
				})}\n`,
				"utf8",
			);
			await writeFile(
				path.join(legacyDir, "indexed_session.json"),
				`${JSON.stringify({
					schema_version: 1,
					session_id: "indexed_session",
					updated_at: "2026-02-08T00:10:00.000Z",
					run_id: "run_old",
					messages: [{ role: "user", content: "old" }],
				})}\n`,
				"utf8",
			);

			const summaries = await store.list();
			expect(summaries).toHaveLength(2);

			const indexed = summaries.find((item) => item.session_id === "indexed_session");
			expect(indexed).toBeTruthy();
			expect(indexed?.run_id).toBe("run_indexed");
			expect(indexed?.last_user_message).toBe("indexed");

			const legacy = summaries.find((item) => item.session_id === "legacy_session");
			expect(legacy).toBeTruthy();
			expect(legacy?.run_id).toBe("run_legacy");
			expect(legacy?.last_user_message).toBe("legacy");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("falls back to updating existing legacy snapshot when sqlite index is unavailable", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "codelia-storage-"));
		try {
			const paths = resolveStoragePaths({ rootOverride: root });
			const legacyDir = path.join(paths.sessionsDir, "state");
			await mkdir(legacyDir, { recursive: true });
			await writeFile(
				path.join(legacyDir, "fallback_session.json"),
				`${JSON.stringify({
					schema_version: 1,
					session_id: "fallback_session",
					updated_at: "2026-02-08T01:20:00.000Z",
					run_id: "run_old",
					messages: [{ role: "user", content: "old" }],
				})}\n`,
				"utf8",
			);
			await mkdir(path.join(paths.sessionsDir, "state.db"), { recursive: true });
			const store = new SessionStateStoreImpl({ paths });

			const state: SessionState = {
				schema_version: 1,
				session_id: "fallback_session",
				updated_at: "2026-02-08T01:30:00.000Z",
				run_id: "run_fallback",
				messages: [{ role: "user", content: "fallback" }],
			};

			await store.save(state);

			const legacyPath = path.join(
				paths.sessionsDir,
				"state",
				"fallback_session.json",
			);
			expect(await Bun.file(legacyPath).exists()).toBe(true);

			const loaded = await store.load("fallback_session");
			expect(loaded).toEqual(state);

			const list = await store.list();
			const fallback = list.find(
				(item) => item.session_id === "fallback_session",
			);
			expect(fallback).toBeTruthy();
			expect(fallback?.last_user_message).toBe("fallback");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("save throws when sqlite is unavailable and no legacy snapshot exists", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "codelia-storage-"));
		try {
			const paths = resolveStoragePaths({ rootOverride: root });
			await mkdir(path.join(paths.sessionsDir, "state.db"), { recursive: true });
			const store = new SessionStateStoreImpl({ paths });
			await expect(
				store.save({
					schema_version: 1,
					session_id: "no_legacy_session",
					updated_at: "2026-02-08T01:40:00.000Z",
					run_id: "run_no_legacy",
					messages: [{ role: "user", content: "no legacy" }],
				}),
			).rejects.toThrow(
				"Session index database unavailable and no legacy snapshot found",
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
