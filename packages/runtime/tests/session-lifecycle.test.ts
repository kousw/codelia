import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionStateStore } from "@codelia/core";
import type { SessionUpdateParams } from "@codelia/protocol";
import {
	cleanupRunLogs,
	resolveStoragePaths,
	SessionStateStoreImpl,
	SessionStoreWriterImpl,
} from "@codelia/storage";
import { createSessionUpdateHandler } from "../src/rpc/session-lifecycle";
import { createHistoryHandlers } from "../src/rpc/history";
import { RuntimeState } from "../src/runtime-state";

async function capture(action: () => Promise<void>) {
	const previous = process.stdout.write;
	const lines: string[] = [];
	process.stdout.write = ((chunk: string | Uint8Array) => {
		lines.push(String(chunk));
		return true;
	}) as typeof process.stdout.write;
	try {
		await action();
	} finally {
		process.stdout.write = previous;
	}
	return lines
		.join("")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

test("invalid lifecycle updates and active-session archive cannot mutate storage", async () => {
	let updates = 0;
	let cleanups = 0;
	const sessions: SessionStateStore = {
		load: async () => null,
		save: async () => {},
		list: async () => [],
		updateMetadata: async () => {
			updates++;
			return { session_id: "session", updated_at: "2026-11-14" };
		},
	};
	const state = new RuntimeState();
	state.sessionId = "session";
	state.activeRunId = "run";
	const handler = createSessionUpdateHandler({
		sessions,
		state,
		log: () => {},
		cleanup: async () => {
			cleanups++;
		},
	});
	const replies = await capture(async () => {
		for (const params of [
			{ session_id: "session" },
			{ session_id: "../session", pinned: true },
			{ session_id: "session", pinned: "yes" },
			{ session_id: "session", archived: true },
		])
			await handler("test", params as SessionUpdateParams);
	});
	expect(replies.every((reply) => reply.error)).toBe(true);
	expect(updates).toBe(0);
	expect(cleanups).toBe(0);
});

test("archive cleanup preserves resume state and usage, and pin protects the history", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "codelia-session-update-"),
	);
	try {
		const paths = resolveStoragePaths({ rootOverride: root });
		const sessions = new SessionStateStoreImpl({ paths });
		const snapshot = {
			schema_version: 1 as const,
			session_id: "session",
			updated_at: new Date().toISOString(),
			messages: [{ role: "user" as const, content: "resume me" }],
		};
		await sessions.save(snapshot);
		const writer = new SessionStoreWriterImpl({
			paths,
			runId: "run",
			startedAt: snapshot.updated_at,
			dump: false,
		});
		await writer.append({
			type: "header",
			run_id: "run",
			session_id: "session",
			started_at: snapshot.updated_at,
			schema_version: 1,
		});
		await writer.append({
			type: "run.end",
			run_id: "run",
			ts: snapshot.updated_at,
			outcome: "completed",
		});
		const handler = createSessionUpdateHandler({
			sessions,
			state: new RuntimeState(),
			log: () => {},
			cleanup: async (sessionId) => {
				await cleanupRunLogs({ paths, sessions, sessionId });
			},
		});
		let replies = await capture(async () => {
			await handler("pin", { session_id: "session", pinned: true });
			await handler("archive", { session_id: "session", archived: true });
		});
		expect(replies.every((reply) => reply.result)).toBe(true);
		expect(await Bun.file(writer.filePath).exists()).toBe(true);
		replies = await capture(async () => {
			await handler("unpin", { session_id: "session", pinned: false });
		});
		expect(replies[0].result.session.archived_at).toBeTruthy();
		expect(await Bun.file(writer.filePath).exists()).toBe(false);
		expect(await Bun.file(`${writer.filePath}.gz`).exists()).toBe(true);
		expect(await sessions.load("session")).toEqual(snapshot);
		const history = createHistoryHandlers({
			sessionStateStore: sessions,
			log: () => {},
			readRunLogs: false,
		});
		const lists = await capture(async () => {
			await history.handleSessionList("normal", { scope: "all" });
			await history.handleSessionList("archived", {
				scope: "all",
				include_archived: true,
			});
		});
		expect(lists[0].result.sessions).toHaveLength(0);
		expect(lists[1].result.sessions[0].session_id).toBe("session");
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("host stores without lifecycle support reject updates without local cleanup", async () => {
	let cleaned = false;
	const sessions: SessionStateStore = {
		load: async () => null,
		save: async () => {},
		list: async () => [],
	};
	const handler = createSessionUpdateHandler({
		sessions,
		state: new RuntimeState(),
		log: () => {},
		cleanup: async () => {
			cleaned = true;
		},
	});
	const replies = await capture(() =>
		handler("host", { session_id: "session", archived: true }),
	);
	expect(replies[0].error).toBeTruthy();
	expect(cleaned).toBe(false);
});
