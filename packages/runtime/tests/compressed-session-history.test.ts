import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import {
	cleanupRunLogs,
	resolveStoragePaths,
	SessionStateStoreImpl,
} from "@codelia/storage";
import { createHistoryHandlers } from "../src/rpc/history";

test("session.history reads compressed events once when plain and gzip files coexist", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "codelia-history-gzip-"),
	);
	const previous = {
		CODELIA_LAYOUT: process.env.CODELIA_LAYOUT,
		XDG_STATE_HOME: process.env.XDG_STATE_HOME,
	};
	const write = process.stdout.write;
	try {
		process.env.CODELIA_LAYOUT = "xdg";
		process.env.XDG_STATE_HOME = root;
		const paths = resolveStoragePaths();
		const sessions = new SessionStateStoreImpl({ paths });
		await sessions.save({
			schema_version: 1,
			session_id: "session",
			updated_at: "2026-11-01",
			messages: [{ role: "user", content: "retained original" }],
		});
		const dir = path.join(paths.sessionsDir, "2026", "11", "01");
		await fs.mkdir(dir, { recursive: true });
		const file = path.join(dir, "run.jsonl");
		const events = `${[
			{
				type: "header",
				run_id: "run",
				session_id: "session",
				started_at: "2026-11-01",
				prompts: { system: "discarded diagnostic prompt" },
			},
			{
				type: "run.start",
				run_id: "run",
				input: { type: "text", text: "old question" },
			},
			{
				type: "llm.request",
				run_id: "run",
				seq: 1,
				input: {
					messages: [
						{ role: "user", content: "discarded diagnostic snapshot" },
					],
				},
			},
			{
				type: "agent.event",
				run_id: "run",
				seq: 1,
				event: { type: "final", content: "old answer" },
			},
		]
			.map((record) => JSON.stringify(record))
			.join("\n")}\n`;
		await fs.writeFile(`${file}.gz`, gzipSync(events));
		const replay: unknown[] = [];
		const handler = createHistoryHandlers({
			sessionStateStore: sessions,
			log: () => {},
			sendHistoryEvent: async (_run, _seq, event) => {
				replay.push(event);
			},
		});
		process.stdout.write = (() => true) as typeof process.stdout.write;
		await handler.handleSessionHistory("gzip", { session_id: "session" });
		expect(replay).toEqual([
			{ type: "hidden_user_message", content: "old question" },
			{ type: "final", content: "old answer" },
		]);
		await sessions.updateMetadata("session", { archived: true });
		expect((await cleanupRunLogs({ paths, sessions })).compressed).toBe(1);
		replay.length = 0;
		await handler.handleSessionHistory("after-diagnostic-removal", {
			session_id: "session",
		});
		expect(replay).toEqual([
			{ type: "hidden_user_message", content: "old question" },
			{ type: "final", content: "old answer" },
		]);
		await fs.writeFile(file, events);
		replay.length = 0;
		await handler.handleSessionHistory("both", { session_id: "session" });
		expect(replay).toHaveLength(2);
	} finally {
		process.stdout.write = write;
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await fs.rm(root, { recursive: true, force: true });
	}
});
