import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	resolveStoragePaths,
	SessionStateStoreImpl,
	SessionStoreWriterImpl,
} from "@codelia/storage";
import { resolveTopLevelAction } from "../src/basic-options";
import { runSessionCommand } from "../src/commands/session";

test("session commands pin and archive the selected session while preserving resume data", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "codelia-session-cli-"));
	const env = {
		CODELIA_LAYOUT: "xdg",
		XDG_STATE_HOME: path.join(root, "state"),
		XDG_CACHE_HOME: path.join(root, "cache"),
		XDG_CONFIG_HOME: path.join(root, "config"),
	};
	const previous = Object.fromEntries(
		Object.keys(env).map((key) => [key, process.env[key]]),
	);
	const stdout = console.log;
	const stderr = console.error;
	const output: string[] = [];
	console.log = (line) => {
		output.push(String(line));
	};
	console.error = console.log;
	try {
		Object.assign(process.env, env);
		const paths = resolveStoragePaths();
		const sessions = new SessionStateStoreImpl({ paths });
		const snapshot = {
			schema_version: 1 as const,
			session_id: "session",
			updated_at: new Date().toISOString(),
			messages: [{ role: "user" as const, content: "saved conversation" }],
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
			schema_version: 1,
			run_id: "run",
			session_id: "session",
			started_at: snapshot.updated_at,
		});
		await writer.append({
			type: "run.end",
			run_id: "run",
			ts: snapshot.updated_at,
			outcome: "completed",
		});
		expect(resolveTopLevelAction(["session", "--help"])).toBe("session");
		expect(await runSessionCommand(["pin", "session"])).toBe(0);
		expect(await runSessionCommand(["archive", "session"])).toBe(0);
		expect(await Bun.file(writer.filePath).exists()).toBe(true);
		expect(await runSessionCommand(["list"])).toBe(0);
		expect(output.some((line) => line.includes("pinned\tarchived"))).toBe(true);
		expect(await runSessionCommand(["unpin", "session"])).toBe(0);
		expect(await Bun.file(writer.filePath).exists()).toBe(false);
		expect(await Bun.file(`${writer.filePath}.gz`).exists()).toBe(true);
		expect(await sessions.load("session")).toEqual(snapshot);
		expect(await runSessionCommand(["unarchive", "session"])).toBe(0);
		expect((await sessions.getSummary("session"))?.archived_at).toBeUndefined();
		expect(await runSessionCommand(["archive", "../outside"])).toBe(1);
	} finally {
		console.log = stdout;
		console.error = stderr;
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await fs.rm(root, { recursive: true, force: true });
	}
});
