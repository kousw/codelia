import { afterEach, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	cleanupRunLogs,
	getProcessIdentity,
	resolveStoragePaths,
	SessionStateStoreImpl,
	SessionStoreWriterImpl,
} from "../src";
import {
	hasActiveRunWriter,
	removeReusedProcessMarkers,
} from "../src/run-log-files";
import { activeRunDirectory } from "../src/run-log-paths";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0))
		await fs.rm(root, { recursive: true, force: true });
});
const OLD = "2026-01-01T00:00:00Z";
const NOW = Date.parse("2026-03-01T00:00:00Z");

test("process identity is stable across timezone and locale settings", async () => {
	const previous = { TZ: process.env.TZ, LC_ALL: process.env.LC_ALL };
	try {
		process.env.TZ = "UTC";
		process.env.LC_ALL = "C";
		const first = await getProcessIdentity(process.pid, {
			canonicalEnvironment: true,
		});
		process.env.TZ = "Asia/Tokyo";
		process.env.LC_ALL = "ja_JP.UTF-8";
		expect(
			await getProcessIdentity(process.pid, { canonicalEnvironment: true }),
		).toBe(first);
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

async function fixture(marker: unknown) {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "codelia-writer-identity-"),
	);
	roots.push(root);
	const paths = resolveStoragePaths({ rootOverride: root });
	const directory = activeRunDirectory(paths, "session");
	await fs.mkdir(directory, { recursive: true });
	const file = path.join(directory, "run.json");
	await fs.writeFile(file, JSON.stringify(marker));
	return { paths, file };
}

for (const scenario of [
	{
		name: "matching identity",
		marker: { pid: process.pid, identity: "saved" },
		current: "saved",
	},
	{
		name: "legacy PID-only marker",
		marker: { pid: process.pid },
		current: "different",
	},
	{
		name: "unavailable saved identity",
		marker: { pid: process.pid, identity: null },
		current: "different",
	},
	{
		name: "unavailable current identity",
		marker: { pid: process.pid, identity: "saved" },
		current: null,
	},
	{
		name: "invalid PID",
		marker: { pid: "invalid", identity: "saved" },
		current: "different",
	},
]) {
	test(`${scenario.name} keeps writer protection`, async () => {
		const f = await fixture(scenario.marker);
		await removeReusedProcessMarkers(
			f.paths,
			"session",
			async () => scenario.current,
		);
		expect(await fs.readFile(f.file, "utf8")).toBe(
			JSON.stringify(scenario.marker),
		);
		expect(hasActiveRunWriter(f.paths, "session")).toBe(true);
	});
}

test("lookup errors and marker replacement keep writer protection", async () => {
	const f = await fixture({ pid: process.pid, identity: "saved" });
	await removeReusedProcessMarkers(f.paths, "session", async () => {
		throw new Error("unavailable");
	});
	expect(hasActiveRunWriter(f.paths, "session")).toBe(true);
	const replacement = { pid: process.pid, identity: "replacement" };
	await removeReusedProcessMarkers(f.paths, "session", async () => {
		await fs.writeFile(f.file, JSON.stringify(replacement));
		return "different";
	});
	expect(JSON.parse(await fs.readFile(f.file, "utf8"))).toEqual(replacement);
	expect(hasActiveRunWriter(f.paths, "session")).toBe(true);
});

test("confirmed PID reuse releases stale protection and allows archival", async () => {
	const f = await fixture({ pid: process.pid, identity: "saved" });
	const sessions = new SessionStateStoreImpl({ paths: f.paths });
	await sessions.save({
		schema_version: 1,
		session_id: "session",
		updated_at: OLD,
		invoke_seq: 0,
		messages: [{ role: "user", content: "keep original" }],
	});
	const writer = new SessionStoreWriterImpl({
		paths: f.paths,
		runId: "completed",
		startedAt: OLD,
	});
	await writer.append({
		type: "header",
		run_id: "completed",
		session_id: "session",
		schema_version: 1,
		started_at: OLD,
	});
	await writer.append({
		type: "run.end",
		run_id: "completed",
		ts: OLD,
		outcome: "completed",
	});
	await fs.utimes(writer.filePath, new Date(OLD), new Date(OLD));
	await removeReusedProcessMarkers(f.paths, "session", async () => "different");
	expect(await Bun.file(f.file).exists()).toBe(false);
	expect(hasActiveRunWriter(f.paths, "session")).toBe(false);
	const result = await cleanupRunLogs({ paths: f.paths, sessions, now: NOW });
	expect(result.compressed).toBe(1);
	expect(result.failed).toBe(0);
	expect(await Bun.file(`${writer.filePath}.gz`).exists()).toBe(true);
});

test("writer records the shared identity and releases its marker on run.end", async () => {
	const f = await fixture({ pid: process.pid });
	await fs.rm(f.file);
	const writer = new SessionStoreWriterImpl({
		paths: f.paths,
		runId: "run",
		startedAt: OLD,
	});
	await writer.append({
		type: "header",
		run_id: "run",
		session_id: "session",
		schema_version: 1,
		started_at: OLD,
	});
	expect(JSON.parse(await fs.readFile(f.file, "utf8"))).toEqual({
		pid: process.pid,
		identity: await getProcessIdentity(process.pid, {
			canonicalEnvironment: true,
		}),
	});
	await removeReusedProcessMarkers(f.paths, "session");
	expect(hasActiveRunWriter(f.paths, "session")).toBe(true);
	await writer.append({
		type: "run.end",
		run_id: "run",
		ts: OLD,
		outcome: "completed",
	});
	expect(await Bun.file(f.file).exists()).toBe(false);
});
