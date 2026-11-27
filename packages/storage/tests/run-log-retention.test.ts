import { afterEach, expect, test } from "bun:test";
import { promises as fs, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
	Agent,
	type BaseChatModel,
	type ChatInvokeInput,
	type SessionRecord,
	type SessionState,
} from "@codelia/core";
import {
	cleanupRunLogs,
	RUN_LOG_RETENTION_MS,
	readRunLogLines,
	resolveStoragePaths,
	SessionStateStoreImpl,
	SessionStoreWriterImpl,
} from "../src";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0))
		await fs.rm(root, { recursive: true, force: true });
});
const NOW = Date.parse("2026-11-14T00:00:00Z");
const OLD = new Date(NOW - RUN_LOG_RETENTION_MS).toISOString();
const diagnosticPath = (writer: SessionStoreWriterImpl): string => {
	if (!writer.diagnosticFilePath)
		throw new Error("Expected an enabled diagnostic file");
	return writer.diagnosticFilePath;
};
const response = {
	type: "llm.response",
	run_id: "run",
	ts: OLD,
	seq: 1,
	output: {
		messages: [{ role: "assistant", content: "private response body" }],
		provider_meta: { opaque: "private provider data" },
		usage: {
			model: "mock",
			input_tokens: 100,
			output_tokens: 5,
			total_tokens: 105,
		},
		timing: { time_to_first_token_ms: 10, generation_duration_ms: 1000 },
	},
} satisfies Extract<SessionRecord, { type: "llm.response" }>;

async function fixture() {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "codelia-log-retention-"),
	);
	roots.push(root);
	const paths = resolveStoragePaths({ rootOverride: root });
	const sessions = new SessionStateStoreImpl({ paths });
	await sessions.list();
	return { root, paths, sessions };
}

async function saveRun(
	f: Awaited<ReturnType<typeof fixture>>,
	sessionId: string,
	options: {
		active?: boolean;
		dump?: boolean;
		updatedAt?: string;
		mtime?: number;
	} = {},
) {
	const snapshot: SessionState = {
		schema_version: 1,
		session_id: sessionId,
		updated_at: options.updatedAt ?? OLD,
		invoke_seq: 7,
		meta: { codelia_todos: { marker: "preserve" }, custom: "preserve" },
		messages: [
			{
				role: "user",
				content: "Remember the current implementation and continue.",
			},
		],
	};
	await f.sessions.save(snapshot);
	const writer = new SessionStoreWriterImpl({
		paths: f.paths,
		runId: sessionId,
		startedAt: OLD,
		dump: options.dump ?? false,
	});
	await writer.append({
		type: "header",
		run_id: sessionId,
		session_id: sessionId,
		started_at: OLD,
		schema_version: 1,
		prompts: { system: "private system prompt" },
		model: { provider: "openai", name: "mock" },
		tools: { definitions: [] },
	});
	await writer.append({
		type: "run.start",
		run_id: sessionId,
		session_id: sessionId,
		ts: OLD,
		input: { type: "text", text: "visible input" },
	});
	await writer.append({
		type: "llm.request",
		run_id: sessionId,
		ts: OLD,
		seq: 1,
		input: { messages: [{ role: "user", content: "private input snapshot" }] },
	});
	await writer.append({ ...response, run_id: sessionId });
	await writer.append({
		type: "tool.output",
		run_id: sessionId,
		ts: OLD,
		tool: "shell",
		tool_call_id: "call",
		result_raw: "private raw tool output",
	});
	if (!options.active)
		await writer.append({
			type: "run.end",
			run_id: sessionId,
			ts: OLD,
			outcome: "completed",
		});
	const modified = new Date(options.mtime ?? NOW - RUN_LOG_RETENTION_MS);
	await fs.utimes(writer.filePath, modified, modified);
	if (writer.diagnosticFilePath)
		await fs.utimes(writer.diagnosticFilePath, modified, modified);
	return { writer, snapshot };
}

test("normal persistence retains events and separate usage without full dumps", async () => {
	const f = await fixture();
	const { writer } = await saveRun(f, "normal");
	const log = await fs.readFile(writer.filePath, "utf8");
	expect(log).toContain('"type":"run.start"');
	expect(log).toContain('"type":"llm.usage"');
	for (const text of [
		"private input snapshot",
		"private response body",
		"private provider data",
		"private raw tool output",
		"private system prompt",
		'"llm.request"',
		'"llm.response"',
	])
		expect(log).not.toContain(text);
	expect(writer.diagnosticFilePath).toBeUndefined();
	const usage = JSON.parse(
		(await fs.readFile(writer.usageFilePath, "utf8")).trim(),
	);
	expect(usage.output.usage.total_tokens).toBe(105);
	expect(usage.session_id).toBe("normal");
	expect(usage.model).toEqual({ provider: "openai", name: "mock" });
	expect(usage.output.messages).toBeUndefined();
	expect(usage.output.provider_meta).toBeUndefined();
});

test("per-call usage preserves provider identity without header models or request dumps", async () => {
	const f = await fixture();
	const writer = new SessionStoreWriterImpl({
		paths: f.paths,
		runId: "child",
		startedAt: OLD,
		dump: false,
	});
	await writer.append({
		type: "header",
		schema_version: 1,
		run_id: "child",
		session_id: "child-session",
		started_at: OLD,
	});
	const providers = ["openai", "endpoint_a", "endpoint_b"];
	for (const [index, provider] of providers.entries())
		await writer.append({
			type: "llm.request",
			run_id: "child",
			ts: OLD,
			seq: index + 1,
			model: { provider, name: "shared-model" },
			input: {
				messages: [{ role: "user", content: "private child request" }],
			},
		});
	for (const seq of [3, 1, 2])
		await writer.append({
			...response,
			run_id: "child",
			seq,
			output: {
				...response.output,
				usage:
					seq === 3
						? null
						: { ...response.output.usage, model: "shared-model" },
			},
		});
	await writer.append({
		type: "run.end",
		run_id: "child",
		ts: OLD,
		outcome: "completed",
	});
	const normalLog = await fs.readFile(writer.filePath, "utf8");
	const normalUsage = normalLog
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line))
		.filter((record) => record.type === "llm.usage");
	const independentUsage = (await fs.readFile(writer.usageFilePath, "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	expect(
		normalUsage.map((record) => ({ seq: record.seq, model: record.model })),
	).toEqual(
		[3, 1, 2].map((seq) => ({
			seq,
			model: { provider: providers[seq - 1], name: "shared-model" },
		})),
	);
	expect(independentUsage).toEqual(normalUsage);
	for (const text of ["private child request", '"llm.request"'])
		expect(normalLog).not.toContain(text);
	expect(writer.diagnosticFilePath).toBeUndefined();
});

test("explicit dump mode saves full payloads in a separate diagnostic file", async () => {
	const f = await fixture();
	const { writer } = await saveRun(f, "diagnostic", { dump: true });
	const dump = await fs.readFile(diagnosticPath(writer), "utf8");
	for (const text of [
		"private input snapshot",
		"private response body",
		"private provider data",
		"private raw tool output",
		"private system prompt",
	])
		expect(dump).toContain(text);
	expect(await fs.readFile(writer.filePath, "utf8")).not.toContain(
		"private response body",
	);
});

test("the dump debug topic is opt-in and can be overridden by the host", async () => {
	const f = await fixture();
	const previous = process.env.CODELIA_DEBUG;
	try {
		delete process.env.CODELIA_DEBUG;
		expect(
			new SessionStoreWriterImpl({
				paths: f.paths,
				runId: "off",
				startedAt: OLD,
			}).diagnosticFilePath,
		).toBeUndefined();
		process.env.CODELIA_DEBUG = "session-dump";
		expect(
			new SessionStoreWriterImpl({
				paths: f.paths,
				runId: "on",
				startedAt: OLD,
			}).diagnosticFilePath,
		).toContain("diagnostics");
		expect(
			new SessionStoreWriterImpl({
				paths: f.paths,
				runId: "host-off",
				startedAt: OLD,
				dump: false,
			}).diagnosticFilePath,
		).toBeUndefined();
	} finally {
		if (previous === undefined) delete process.env.CODELIA_DEBUG;
		else process.env.CODELIA_DEBUG = previous;
	}
});

test("30-day boundary and archive compress events and expire only diagnostic dumps", async () => {
	const f = await fixture();
	const expired = await saveRun(f, "expired");
	const originalEvents = await fs.readFile(expired.writer.filePath);
	const recent = await saveRun(f, "recent", {
		updatedAt: new Date(NOW - RUN_LOG_RETENTION_MS + 1).toISOString(),
		mtime: NOW - RUN_LOG_RETENTION_MS + 1,
	});
	const pinned = await saveRun(f, "pinned", { dump: true });
	await f.sessions.updateMetadata("pinned", { pinned: true, archived: true });
	const archived = await saveRun(f, "archived", {
		updatedAt: new Date(NOW).toISOString(),
		mtime: NOW,
		dump: true,
	});
	await f.sessions.updateMetadata("archived", { archived: true });
	const active = await saveRun(f, "active", { active: true });
	await f.sessions.updateMetadata("active", { archived: true });
	const image = path.join(f.paths.sessionsDir, "image-artifacts", "keep.png");
	const output = path.join(f.paths.toolOutputCacheDir, "keep.txt");
	await fs.mkdir(path.dirname(image), { recursive: true });
	await fs.mkdir(path.dirname(output), { recursive: true });
	await fs.writeFile(image, "image-reference-bytes");
	await fs.writeFile(output, "tool-reference-bytes");
	const before = await fs.readFile(
		path.join(f.paths.sessionsDir, "messages", "expired.jsonl"),
	);
	const result = await cleanupRunLogs({
		paths: f.paths,
		sessions: f.sessions,
		now: NOW,
	});
	expect(result.deleted).toBe(1);
	expect(result.compressed).toBe(2);
	expect(result.failed).toBe(0);
	const originalRecords = originalEvents
		.toString("utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	const archivedRecords = gunzipSync(
		await fs.readFile(`${expired.writer.filePath}.gz`),
	)
		.toString("utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	const events = (records: typeof originalRecords) =>
		records.filter(
			(record) => record.type !== "header" && record.type !== "llm.usage",
		);
	expect(events(archivedRecords)).toEqual(events(originalRecords));
	expect(archivedRecords.find((record) => record.type === "llm.usage")).toEqual(
		originalRecords.find((record) => record.type === "llm.usage"),
	);
	expect(archivedRecords[0].meta.codelia_log_archive_version).toBe(1);
	for (const item of [expired, archived]) {
		expect(await Bun.file(item.writer.filePath).exists()).toBe(false);
		expect(await Bun.file(`${item.writer.filePath}.gz`).exists()).toBe(true);
	}
	for (const item of [recent, pinned, active])
		expect(await Bun.file(item.writer.filePath).exists()).toBe(true);
	expect(await Bun.file(diagnosticPath(pinned.writer)).exists()).toBe(true);
	expect(await Bun.file(diagnosticPath(archived.writer)).exists()).toBe(false);
	expect(
		await fs.readFile(
			path.join(f.paths.sessionsDir, "messages", "expired.jsonl"),
		),
	).toEqual(before);
	expect(await f.sessions.load("expired")).toEqual(expired.snapshot);
	expect(await fs.readFile(image, "utf8")).toBe("image-reference-bytes");
	expect(await fs.readFile(output, "utf8")).toBe("tool-reference-bytes");
	expect(await Bun.file(expired.writer.usageFilePath).exists()).toBe(true);
	await active.writer.append({
		type: "run.end",
		run_id: "active",
		ts: OLD,
		outcome: "completed",
	});
	expect(
		(
			await cleanupRunLogs({
				paths: f.paths,
				sessions: f.sessions,
				now: NOW,
				sessionId: "active",
			})
		).compressed,
	).toBe(1);
});

test("pinning before compression commit retains the source and removes temporary gzip", async () => {
	const f = await fixture();
	const { writer } = await saveRun(f, "late-pin");
	const originalEvents = await fs.readFile(writer.filePath);
	const guard = f.sessions.withRetentionGuard.bind(f.sessions);
	let reachedCommit = false;
	f.sessions.withRetentionGuard = async (sessionId, action) => {
		reachedCommit = true;
		f.sessions.withRetentionGuard = guard;
		await f.sessions.updateMetadata(sessionId, { pinned: true });
		return guard(sessionId, action);
	};
	const result = await cleanupRunLogs({
		paths: f.paths,
		sessions: f.sessions,
		now: NOW,
	});
	expect(reachedCommit).toBe(true);
	expect(result).toEqual({
		deleted: 0,
		compressed: 0,
		skipped: 1,
		failed: 0,
		reclaimed_bytes: 0,
	});
	expect(await fs.readFile(writer.filePath)).toEqual(originalEvents);
	expect(await fs.readdir(path.dirname(writer.filePath))).toEqual([
		"late-pin.jsonl",
	]);
	expect((await f.sessions.getSummary("late-pin"))?.pinned).toBe(true);
});

test("pin/archive state survives stale resume saves without rewriting message payloads", async () => {
	const f = await fixture();
	const { snapshot } = await saveRun(f, "metadata");
	const file = path.join(f.paths.sessionsDir, "messages", "metadata.jsonl");
	const before = await fs.readFile(file);
	await f.sessions.updateMetadata("metadata", { pinned: true, archived: true });
	expect(await fs.readFile(file)).toEqual(before);
	await f.sessions.save(snapshot);
	const second = new SessionStateStoreImpl({ paths: f.paths });
	expect((await second.getSummary("metadata"))?.pinned).toBe(true);
	expect((await second.getSummary("metadata"))?.archived_at).toBeTruthy();
	await second.updateMetadata("metadata", { pinned: false, archived: false });
	expect((await f.sessions.getSummary("metadata"))?.pinned).toBeUndefined();
	expect(
		(await f.sessions.getSummary("metadata"))?.archived_at,
	).toBeUndefined();
});

test("recent session activity retains new logs while older runs are compressed", async () => {
	const f = await fixture();
	const old = await saveRun(f, "long-conversation");
	const snapshot = { ...old.snapshot, updated_at: new Date(NOW).toISOString() };
	await f.sessions.save(snapshot);
	const current = new SessionStoreWriterImpl({
		paths: f.paths,
		runId: "recent-run",
		startedAt: snapshot.updated_at,
		dump: false,
	});
	await current.append({
		type: "header",
		run_id: "recent-run",
		session_id: snapshot.session_id,
		started_at: snapshot.updated_at,
		schema_version: 1,
	});
	await current.append({
		type: "run.end",
		run_id: "recent-run",
		ts: snapshot.updated_at,
		outcome: "completed",
	});
	await fs.utimes(current.filePath, new Date(NOW), new Date(NOW));
	const result = await cleanupRunLogs({
		paths: f.paths,
		sessions: f.sessions,
		now: NOW,
	});
	expect(result.compressed).toBe(1);
	expect(result.failed).toBe(0);
	expect(await Bun.file(old.writer.filePath).exists()).toBe(false);
	expect(await Bun.file(current.filePath).exists()).toBe(true);
	expect(await f.sessions.load(snapshot.session_id)).toEqual(snapshot);
});

test("legacy response usage is extracted before compressing a large mixed log", async () => {
	const f = await fixture();
	const { writer } = await saveRun(f, "legacy");
	const header = {
		type: "header",
		run_id: "legacy",
		session_id: "legacy",
		started_at: OLD,
		schema_version: 1,
	};
	await fs.unlink(writer.usageFilePath);
	await fs.writeFile(
		writer.filePath,
		`${[
			header,
			{
				type: "llm.request",
				input: {
					messages: [
						{ content: `data:image/png;base64,${"A".repeat(2 * 1024 * 1024)}` },
					],
				},
			},
			{ ...response, run_id: "legacy" },
		]
			.map((record) => JSON.stringify(record))
			.join("\n")}\n`,
	);
	await f.sessions.updateMetadata("legacy", { archived: true });
	expect(
		(await cleanupRunLogs({ paths: f.paths, sessions: f.sessions, now: NOW }))
			.compressed,
	).toBe(1);
	const usage = await fs.readFile(writer.usageFilePath, "utf8");
	expect(usage).toContain('"total_tokens":105');
	expect(usage).not.toContain("private response body");
	expect(usage.length).toBeLessThan(1000);
});

test("unknown sessions, missing snapshots, malformed usage and symlinks are retained", async () => {
	const f = await fixture();
	const unknown = new SessionStoreWriterImpl({
		paths: f.paths,
		runId: "unknown",
		startedAt: OLD,
		dump: false,
	});
	await unknown.append({
		type: "header",
		run_id: "unknown",
		session_id: "unknown",
		started_at: OLD,
		schema_version: 1,
	});
	await unknown.append({
		type: "run.end",
		run_id: "unknown",
		ts: OLD,
		outcome: "completed",
	});
	await fs.utimes(unknown.filePath, new Date(OLD), new Date(OLD));
	const missing = await saveRun(f, "missing");
	await fs.unlink(path.join(f.paths.sessionsDir, "messages", "missing.jsonl"));
	const corrupt = await saveRun(f, "corrupt");
	await f.sessions.updateMetadata("corrupt", { archived: true });
	await fs.appendFile(
		corrupt.writer.filePath,
		'{"type":"llm.response","output":',
	);
	const outside = path.join(f.root, "outside.jsonl");
	await fs.writeFile(outside, "preserve outside");
	await fs.symlink(
		outside,
		path.join(path.dirname(missing.writer.filePath), "symlink.jsonl"),
	);
	const result = await cleanupRunLogs({
		paths: f.paths,
		sessions: f.sessions,
		now: NOW,
	});
	expect(result.deleted).toBe(0);
	expect(result.failed).toBe(1);
	expect(await Bun.file(unknown.filePath).exists()).toBe(true);
	expect(await Bun.file(missing.writer.filePath).exists()).toBe(true);
	expect(await Bun.file(corrupt.writer.filePath).exists()).toBe(true);
	expect(await fs.readFile(outside, "utf8")).toBe("preserve outside");
});

test("compression never overwrites an existing destination or removes its source on conflict", async () => {
	const f = await fixture();
	const { writer } = await saveRun(f, "conflict");
	const original = await fs.readFile(writer.filePath);
	await fs.writeFile(`${writer.filePath}.gz`, "existing independent archive");
	const result = await cleanupRunLogs({
		paths: f.paths,
		sessions: f.sessions,
		now: NOW,
	});
	expect(result.failed).toBe(1);
	expect(result.compressed).toBe(0);
	expect(await fs.readFile(writer.filePath)).toEqual(original);
	expect(await fs.readFile(`${writer.filePath}.gz`, "utf8")).toBe(
		"existing independent archive",
	);
});

test("reader follows the gzip handoff when plain disappears during asynchronous open", async () => {
	const f = await fixture();
	const file = path.join(f.root, "race.jsonl");
	await fs.writeFile(`${file}.gz`, gzipSync("original event\n"));
	for (let iteration = 0; iteration < 10; iteration++) {
		await fs.writeFile(file, "original event\n");
		const reader = readRunLogLines(file);
		const pending = reader.next();
		unlinkSync(file);
		expect((await pending).value).toBe("original event");
		await reader.return(undefined);
	}
});

test("diagnostic expiry does not replace canonical compact usage with less complete response data", async () => {
	const f = await fixture();
	const { writer } = await saveRun(f, "provider-usage", { dump: true });
	const before = JSON.parse(
		(await fs.readFile(writer.usageFilePath, "utf8")).trim(),
	);
	expect(before.model.provider).toBe("openai");
	const result = await cleanupRunLogs({
		paths: f.paths,
		sessions: f.sessions,
		now: NOW,
	});
	expect(result.failed).toBe(0);
	expect(
		JSON.parse((await fs.readFile(writer.usageFilePath, "utf8")).trim()),
	).toEqual(before);
});

test("the same checkpoint produces identical next model input after event compression", async () => {
	const f = await fixture();
	const { writer } = await saveRun(f, "resume");
	const inputs: ChatInvokeInput[] = [];
	const model: BaseChatModel = {
		provider: "openai",
		model: "gpt-5",
		ainvoke: async (input) => {
			inputs.push(
				JSON.parse(
					JSON.stringify({
						messages: input.messages,
						tools: input.tools,
						toolChoice: input.toolChoice,
					}),
				),
			);
			return { messages: [{ role: "assistant", content: "continued" }] };
		},
	};
	const resume = async () => {
		const snapshot = await f.sessions.load("resume");
		if (!snapshot) throw new Error("Expected a saved resume snapshot");
		const agent = new Agent({
			llm: model,
			tools: [],
			compaction: null,
			toolOutputCache: null,
		});
		agent.replaceHistoryMessages(snapshot.messages);
		await agent.run("Continue working.");
	};
	await resume();
	expect(
		(await cleanupRunLogs({ paths: f.paths, sessions: f.sessions, now: NOW }))
			.compressed,
	).toBe(1);
	expect(await Bun.file(writer.filePath).exists()).toBe(false);
	await resume();
	expect(inputs).toHaveLength(2);
	expect(inputs[1]).toEqual(inputs[0]);
});
