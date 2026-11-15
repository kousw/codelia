import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import type { AgentEvent, SessionStateStore } from "@codelia/core";
import {
	resolveStoragePaths,
	SessionStateStoreImpl,
	SessionStoreWriterImpl,
} from "@codelia/storage";
import { createHistoryHandlers } from "../src/rpc/history";

const ENV_KEYS = [
	"CODELIA_LAYOUT",
	"XDG_STATE_HOME",
	"XDG_CACHE_HOME",
	"XDG_CONFIG_HOME",
] as const;
let root = "";
let previousEnv: Array<readonly [string, string | undefined]> = [];

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "codelia-history-index-"));
	previousEnv = ENV_KEYS.map((key) => [key, process.env[key]] as const);
	process.env.CODELIA_LAYOUT = "xdg";
	process.env.XDG_STATE_HOME = path.join(root, "state");
	process.env.XDG_CACHE_HOME = path.join(root, "cache");
	process.env.XDG_CONFIG_HOME = path.join(root, "config");
	// Never touch the real ~/.codelia store.
	expect(resolveStoragePaths().sessionsDir.startsWith(root)).toBe(true);
});

afterEach(async () => {
	for (const [key, value] of previousEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await fs.rm(root, { recursive: true, force: true });
});

const lines = (sessionId: string, runId: string, startedAt: string) =>
	`${[
		{
			type: "header",
			schema_version: 1,
			run_id: runId,
			session_id: sessionId,
			started_at: startedAt,
		},
		{
			type: "run.start",
			run_id: runId,
			ts: startedAt,
			input: { type: "text", text: `question ${runId}` },
		},
		{
			type: "agent.event",
			run_id: runId,
			ts: startedAt,
			seq: 0,
			event: { type: "final", content: `answer ${runId}` },
		},
	]
		.map((record) => JSON.stringify(record))
		.join("\n")}\n`;

const runFile = (runId: string, startedAt: string): string =>
	path.join(
		resolveStoragePaths().sessionsDir,
		...startedAt.slice(0, 10).split("-"),
		`${runId}.jsonl`,
	);

/** Written without the index, as by a runtime that predates it. */
async function writeLegacyRun(
	sessionId: string,
	runId: string,
	startedAt: string,
	gzip = false,
): Promise<string> {
	const file = runFile(runId, startedAt);
	await fs.mkdir(path.dirname(file), { recursive: true });
	const content = lines(sessionId, runId, startedAt);
	if (gzip) await fs.writeFile(`${file}.gz`, gzipSync(content));
	else await fs.writeFile(file, content);
	return file;
}

async function writeIndexedRun(
	sessions: SessionStateStoreImpl,
	sessionId: string,
	runId: string,
	startedAt: string,
): Promise<string> {
	const writer = new SessionStoreWriterImpl({
		runId,
		startedAt,
		runIndex: sessions,
	});
	for (const line of lines(sessionId, runId, startedAt).trim().split("\n"))
		await writer.append(JSON.parse(line));
	await writer.append({
		type: "run.end",
		run_id: runId,
		ts: startedAt,
		outcome: "completed",
	});
	return writer.filePath;
}

async function writeUnrelatedRuns(count: number): Promise<void> {
	await Promise.all(
		Array.from({ length: count }, (_, index) => {
			const day = String((index % 28) + 1).padStart(2, "0");
			return writeLegacyRun(
				`other-${index % 500}`,
				`other-run-${index}`,
				`2026-10-${day}T00:00:00.000Z`,
				index % 25 !== 0,
			);
		}),
	);
}

type Replay = { runId: string; seq: number; event: AgentEvent };

async function history(
	sessionStateStore: SessionStateStore,
	params: { session_id: string; max_runs?: number; max_events?: number },
): Promise<{ replay: Replay[]; result: unknown }> {
	const replay: Replay[] = [];
	const handler = createHistoryHandlers({
		sessionStateStore,
		log: () => {},
		sendHistoryEvent: (runId, seq, event) => {
			replay.push({ runId, seq, event });
		},
	});
	const write = process.stdout.write;
	let output = "";
	process.stdout.write = ((chunk: string | Uint8Array) => {
		output += String(chunk);
		return true;
	}) as typeof process.stdout.write;
	try {
		await handler.handleSessionHistory("h", params);
	} finally {
		process.stdout.write = write;
	}
	const response = JSON.parse(output.trim().split("\n").at(-1) ?? "{}");
	return { replay, result: response.result };
}

/** Not a SessionStateStoreImpl, so history uses the legacy header scan. */
const legacyStore = (): SessionStateStore => ({
	load: async () => null,
	save: async () => {},
	list: async () => [],
});

const openedRunLogs = (calls: unknown[][]): string[] =>
	calls
		.map((call) => String(call[0]))
		.filter((file) => /\.jsonl(?:\.gz)?$/.test(file));

test("no index yet: falls back to the scan, then answers from the index", async () => {
	const sessions = new SessionStateStoreImpl();
	await writeLegacyRun("target", "t1", "2026-11-01T00:00:00.000Z", true);
	await writeLegacyRun("target", "t2", "2026-11-02T00:00:00.000Z");
	await writeLegacyRun("target", "t3", "2026-11-03T00:00:00.000Z", true);
	await writeUnrelatedRuns(2000);
	const params = { session_id: "target", max_runs: 2 };

	const expected = await history(legacyStore(), params);
	expect(expected.result).toEqual({ runs: 2, events_sent: 4 });
	expect(expected.replay.map((entry) => entry.runId)).toEqual([
		"t2",
		"t2",
		"t3",
		"t3",
	]);
	expect(await history(sessions, params)).toEqual(expected);

	// The next open reads only the selected logs; nothing else is listed or opened.
	const open = spyOn(fs, "open");
	const readdir = spyOn(fs, "readdir");
	try {
		expect(await history(sessions, params)).toEqual(expected);
		expect(readdir).not.toHaveBeenCalled();
		expect(openedRunLogs(open.mock.calls).sort()).toEqual(
			[
				runFile("t2", "2026-11-02T00:00:00.000Z"),
				`${runFile("t3", "2026-11-03T00:00:00.000Z")}.gz`,
			].sort(),
		);
	} finally {
		open.mockRestore();
		readdir.mockRestore();
	}
});

test("indexed runs: thousands of other logs are never opened", async () => {
	const sessions = new SessionStateStoreImpl();
	await history(sessions, { session_id: "warmup" });
	await writeIndexedRun(sessions, "target", "t1", "2026-11-01T00:00:00.000Z");
	await writeIndexedRun(sessions, "target", "t2", "2026-11-02T00:00:00.000Z");
	await writeUnrelatedRuns(3000);
	await sessions.save({
		schema_version: 1,
		session_id: "target",
		updated_at: "2026-11-02T00:00:01.000Z",
		run_id: "t2",
		messages: [],
	});

	const open = spyOn(fs, "open");
	const readdir = spyOn(fs, "readdir");
	let indexed: Awaited<ReturnType<typeof history>>;
	try {
		indexed = await history(sessions, { session_id: "target" });
		expect(readdir).not.toHaveBeenCalled();
		expect(openedRunLogs(open.mock.calls).sort()).toEqual(
			[
				runFile("t1", "2026-11-01T00:00:00.000Z"),
				runFile("t2", "2026-11-02T00:00:00.000Z"),
			].sort(),
		);
	} finally {
		open.mockRestore();
		readdir.mockRestore();
	}
	expect(indexed).toEqual(
		await history(legacyStore(), { session_id: "target" }),
	);
	expect(indexed.result).toEqual({ runs: 2, events_sent: 4 });
});

test("indexed runs replaced by gzip are read; missing logs are skipped", async () => {
	const sessions = new SessionStateStoreImpl();
	const t1 = await writeIndexedRun(
		sessions,
		"target",
		"t1",
		"2026-11-01T00:00:00.000Z",
	);
	const t2 = await writeIndexedRun(
		sessions,
		"target",
		"t2",
		"2026-11-02T00:00:00.000Z",
	);
	const t3 = await writeIndexedRun(
		sessions,
		"target",
		"t3",
		"2026-11-03T00:00:00.000Z",
	);
	await history(sessions, { session_id: "target" });

	await fs.writeFile(`${t3}.gz`, gzipSync(await fs.readFile(t3)));
	await fs.rm(t3);
	await fs.rm(t2);
	const { replay, result } = await history(sessions, {
		session_id: "target",
		max_runs: 2,
	});
	// The deleted t2 does not use up max_runs; t1 fills its place.
	expect(result).toEqual({ runs: 2, events_sent: 4 });
	expect(replay).toEqual([
		{
			runId: "t1",
			seq: -1,
			event: { type: "hidden_user_message", content: "question t1" },
		},
		{ runId: "t1", seq: 0, event: { type: "final", content: "answer t1" } },
		{
			runId: "t3",
			seq: -1,
			event: { type: "hidden_user_message", content: "question t3" },
		},
		{ runId: "t3", seq: 0, event: { type: "final", content: "answer t3" } },
	]);
	expect(await history(legacyStore(), { session_id: "target" })).toEqual({
		replay,
		result,
	});
	expect(t1.endsWith(path.join("2026", "11", "01", "t1.jsonl"))).toBe(true);
});
