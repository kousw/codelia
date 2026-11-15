import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
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
		const dir = path.join(root, "codelia", "sessions", "2026", "11", "01");
		await fs.mkdir(dir, { recursive: true });
		const file = path.join(dir, "run.jsonl");
		const events = `${[
			{
				type: "header",
				run_id: "run",
				session_id: "session",
				started_at: "2026-11-01",
			},
			{
				type: "run.start",
				run_id: "run",
				input: { type: "text", text: "old question" },
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
			sessionStateStore: {
				load: async () => null,
				save: async () => {},
				list: async () => [],
			},
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
