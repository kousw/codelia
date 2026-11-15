import { afterEach, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { StoragePaths } from "@codelia/core";
import {
	cleanupRunLogs,
	RunEventStoreFactoryImpl,
	resolveIndexedRunLog,
	resolveStoragePaths,
	SessionStateStoreImpl,
	SessionStoreWriterImpl,
} from "../src";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0))
		await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "codelia-run-index-"));
	roots.push(root);
	const paths = resolveStoragePaths({ rootOverride: root });
	const sessions = new SessionStateStoreImpl({ paths });
	await sessions.list();
	return { root, paths, sessions };
}

/** A run log written without the index, as by a runtime that predates it. */
async function writeLegacyRun(
	paths: StoragePaths,
	sessionId: string,
	runId: string,
	startedAt: string,
): Promise<string> {
	const dir = path.join(
		paths.sessionsDir,
		...startedAt.slice(0, 10).split("-"),
	);
	await fs.mkdir(dir, { recursive: true });
	const file = path.join(dir, `${runId}.jsonl`);
	await fs.writeFile(
		file,
		`${JSON.stringify({
			type: "header",
			schema_version: 1,
			run_id: runId,
			session_id: sessionId,
			started_at: startedAt,
		})}\n`,
	);
	return file;
}

async function writeIndexedRun(
	paths: StoragePaths,
	sessions: SessionStateStoreImpl,
	sessionId: string,
	runId: string,
	startedAt: string,
): Promise<string> {
	const writer = new SessionStoreWriterImpl({
		runId,
		startedAt,
		paths,
		runIndex: sessions,
	});
	await writer.append({
		type: "header",
		schema_version: 1,
		run_id: runId,
		session_id: sessionId,
		started_at: startedAt,
	});
	await writer.append({
		type: "run.end",
		run_id: runId,
		ts: startedAt,
		outcome: "completed",
	});
	return writer.filePath;
}

const ids = (entries: { run_id: string }[]) =>
	entries.map((entry) => entry.run_id);

test("writer records session runs and the backfill indexes legacy logs once", async () => {
	const { paths, sessions } = await fixture();
	await writeLegacyRun(paths, "s1", "legacy-1", "2026-11-01T00:00:00.000Z");
	await writeLegacyRun(paths, "s2", "other-1", "2026-11-02T00:00:00.000Z");
	await writeIndexedRun(paths, sessions, "s1", "new-1", "2026-11-03T00:00:00Z");

	// No backfill yet: one store-wide scan fills every session.
	expect(ids(await sessions.listSessionRuns("s1"))).toEqual([
		"new-1",
		"legacy-1",
	]);
	const readdir = spyOn(fs, "readdir");
	const open = spyOn(fs, "open");
	try {
		expect(ids(await sessions.listSessionRuns("s2"))).toEqual(["other-1"]);
		await writeIndexedRun(
			paths,
			sessions,
			"s1",
			"new-2",
			"2026-11-04T00:00:00Z",
		);
		expect(ids(await sessions.listSessionRuns("s1"))).toEqual([
			"new-2",
			"new-1",
			"legacy-1",
		]);
		expect(readdir).not.toHaveBeenCalled();
		expect(open).not.toHaveBeenCalled();
	} finally {
		readdir.mockRestore();
		open.mockRestore();
	}
	const [entry] = await sessions.listSessionRuns("s2");
	expect(entry?.rel_path).toBe("2026/11/02/other-1.jsonl");
});

test("an unindexed latest run_id triggers one rescan, then is remembered", async () => {
	const { paths, sessions } = await fixture();
	await sessions.listSessionRuns("warmup");
	// Written by an older runtime after the backfill: no index row.
	await writeLegacyRun(paths, "s1", "late", "2026-11-05T00:00:00.000Z");
	await sessions.save({
		schema_version: 1,
		session_id: "s1",
		updated_at: "2026-11-05T00:00:01.000Z",
		run_id: "late",
		messages: [],
	});
	expect(ids(await sessions.listSessionRuns("s1"))).toEqual(["late"]);

	// A latest run_id with no log at all is rescanned only once.
	await sessions.save({
		schema_version: 1,
		session_id: "s1",
		updated_at: "2026-11-05T00:00:02.000Z",
		run_id: "never-written",
		messages: [],
	});
	expect(ids(await sessions.listSessionRuns("s1"))).toEqual(["late"]);
	const readdir = spyOn(fs, "readdir");
	try {
		expect(ids(await sessions.listSessionRuns("s1"))).toEqual(["late"]);
		expect(readdir).not.toHaveBeenCalled();
	} finally {
		readdir.mockRestore();
	}
});

test("concurrent stores sharing state.db keep one row per log", async () => {
	const { paths, sessions } = await fixture();
	const other = new SessionStateStoreImpl({ paths });
	for (let index = 0; index < 20; index += 1)
		await writeLegacyRun(
			paths,
			"s1",
			`run-${index}`,
			"2026-11-01T00:00:00.000Z",
		);
	const [left, right] = await Promise.all([
		sessions.listSessionRuns("s1"),
		other.listSessionRuns("s1"),
	]);
	expect(left).toHaveLength(20);
	expect(right).toHaveLength(20);
	await writeIndexedRun(paths, other, "s1", "run-0", "2026-11-01T00:00:00Z");
	expect(await sessions.listSessionRuns("s1")).toHaveLength(20);
});

test("the default factory indexes runs without an explicit recorder", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "codelia-run-index-"));
	roots.push(root);
	const keys = [
		"CODELIA_LAYOUT",
		"XDG_STATE_HOME",
		"XDG_CACHE_HOME",
		"XDG_CONFIG_HOME",
	] as const;
	const previous = keys.map((key) => [key, process.env[key]] as const);
	process.env.CODELIA_LAYOUT = "xdg";
	process.env.XDG_STATE_HOME = path.join(root, "state");
	process.env.XDG_CACHE_HOME = path.join(root, "cache");
	process.env.XDG_CONFIG_HOME = path.join(root, "config");
	try {
		const paths = resolveStoragePaths();
		// Never touch the real store: every default path must be under root.
		expect(paths.sessionsDir.startsWith(root)).toBe(true);
		const sessions = new SessionStateStoreImpl({ paths });
		const store = new RunEventStoreFactoryImpl().create({
			runId: "factory-run",
			startedAt: "2026-11-06T00:00:00.000Z",
		});
		await store.append({
			type: "header",
			schema_version: 1,
			run_id: "factory-run",
			session_id: "s1",
			started_at: "2026-11-06T00:00:00.000Z",
		});
		await fs.rm(path.join(paths.sessionsDir, "2026"), {
			recursive: true,
			force: true,
		});
		await sessions.listSessionRuns("warmup");
		// The row came from the writer, not from the (now empty) scan.
		expect(ids(await sessions.listSessionRuns("s1"))).toEqual(["factory-run"]);
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

test("session-scoped cleanup inspects only the session's indexed logs", async () => {
	const { paths, sessions } = await fixture();
	const OLD = "2026-01-01T00:00:00.000Z";
	const target = await writeIndexedRun(paths, sessions, "target", "t1", OLD);
	await sessions.save({
		schema_version: 1,
		session_id: "target",
		updated_at: OLD,
		run_id: "t1",
		messages: [{ role: "user", content: "kept" }],
	});
	for (let index = 0; index < 300; index += 1)
		await writeIndexedRun(paths, sessions, `other-${index}`, `o${index}`, OLD);
	await sessions.listSessionRuns("target");
	await sessions.updateMetadata("target", { archived: true });

	const open = spyOn(fs, "open");
	try {
		const result = await cleanupRunLogs({
			paths,
			sessions,
			sessionId: "target",
		});
		expect(result.compressed).toBe(1);
		const opened = open.mock.calls.map((call) => String(call[0]));
		expect(opened.some((file) => /[\\/]o\d+\.jsonl/.test(file))).toBe(false);
		expect(opened.some((file) => file.startsWith(target))).toBe(true);
	} finally {
		open.mockRestore();
	}
	expect((await fs.stat(`${target}.gz`)).isFile()).toBe(true);
});

test("a transient readdir failure does not mark the backfill complete", async () => {
	const { paths, sessions } = await fixture();
	await writeLegacyRun(paths, "s1", "legacy-1", "2026-11-01T00:00:00.000Z");
	const failure = Object.assign(new Error("too many open files"), {
		code: "EMFILE",
	});
	const readdir = spyOn(fs, "readdir").mockImplementationOnce(async () => {
		throw failure;
	});
	try {
		await expect(sessions.listSessionRuns("s1")).rejects.toBe(failure);
	} finally {
		readdir.mockRestore();
	}
	// Nothing was recorded, so the next call scans again and finds the run.
	expect(ids(await sessions.listSessionRuns("s1"))).toEqual(["legacy-1"]);
});

test("started_at is normalized so mixed precisions order chronologically", async () => {
	const { sessions } = await fixture();
	await sessions.listSessionRuns("warmup");
	for (const [run_id, started_at] of [
		["whole-second", "2026-11-01T00:00:00Z"],
		["later-millis", "2026-11-01T00:00:00.500Z"],
		["offset", "2026-11-01T09:00:01+09:00"],
	] as const)
		await sessions.recordSessionRun({
			session_id: "s1",
			run_id,
			rel_path: `2026/11/01/${run_id}.jsonl`,
			started_at,
		});
	const runs = await sessions.listSessionRuns("s1");
	expect(ids(runs)).toEqual(["offset", "later-millis", "whole-second"]);
	expect(runs.at(-1)?.started_at).toBe("2026-11-01T00:00:00.000Z");
});

test("indexed paths resolve only to regular files", async () => {
	const { paths } = await fixture();
	const dir = path.join(paths.sessionsDir, "2026", "11", "01");
	await fs.mkdir(dir, { recursive: true });
	const real = path.join(dir, "real.jsonl");
	await fs.writeFile(real, "{}\n");
	await fs.symlink(real, path.join(dir, "link.jsonl"));
	execFileSync("mkfifo", [path.join(dir, "fifo.jsonl")]);
	await fs.mkdir(path.join(dir, "dir.jsonl"));
	await fs.writeFile(path.join(dir, "gz-only.jsonl.gz"), "");
	await fs.mkdir(path.join(dir, "gz-dir.jsonl.gz"));
	const resolve = (name: string) =>
		resolveIndexedRunLog(paths.sessionsDir, `2026/11/01/${name}.jsonl`);
	expect(resolve("real")).toBe(real);
	expect(resolve("link")).toBeUndefined();
	expect(resolve("fifo")).toBeUndefined();
	expect(resolve("dir")).toBeUndefined();
	expect(resolve("gz-only")).toBe(path.join(dir, "gz-only.jsonl.gz"));
	expect(resolve("gz-dir")).toBeUndefined();
	expect(resolveIndexedRunLog(paths.sessionsDir, "../escape.jsonl")).toBe(
		undefined,
	);
});

test("session-scoped cleanup skips a FIFO at an indexed path without blocking", async () => {
	const { paths, sessions } = await fixture();
	const file = await writeIndexedRun(
		paths,
		sessions,
		"target",
		"t1",
		"2026-01-01T00:00:00.000Z",
	);
	await sessions.save({
		schema_version: 1,
		session_id: "target",
		updated_at: "2026-01-01T00:00:00.000Z",
		run_id: "t1",
		messages: [{ role: "user", content: "kept" }],
	});
	await sessions.updateMetadata("target", { archived: true });
	await fs.rm(file);
	execFileSync("mkfifo", [file]);
	const result = await cleanupRunLogs({ paths, sessions, sessionId: "target" });
	expect(result.compressed).toBe(0);
	expect(result.failed).toBe(0);
});
