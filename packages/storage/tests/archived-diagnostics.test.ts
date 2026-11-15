import { afterEach, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { LlmUsageRecord, SessionRecord } from "@codelia/core";
import {
	cleanupRunLogs,
	resolveStoragePaths,
	SessionStateStoreImpl,
} from "../src";

const OLD = "2026-10-01T00:00:00.000Z";
const NOW = Date.parse("2026-11-15T00:00:00.000Z");
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0))
		await fs.rm(root, { recursive: true, force: true });
});

async function fixture(format: "plain" | "gzip", requestBytes = 1024) {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "codelia-archived-diagnostics-"),
	);
	roots.push(root);
	const paths = resolveStoragePaths({ rootOverride: root });
	const sessions = new SessionStateStoreImpl({ paths });
	const snapshot = {
		schema_version: 1 as const,
		session_id: "session",
		updated_at: OLD,
		messages: [{ role: "user" as const, content: "retained original" }],
	};
	await sessions.save(snapshot);
	const records: SessionRecord[] = [
		{
			type: "header",
			schema_version: 1,
			run_id: "run",
			session_id: "session",
			started_at: OLD,
			model: { provider: "endpoint_a", name: "shared-model" },
			prompts: { system: "diagnostic-header-sentinel" },
			tools: { definitions: [] },
			meta: { keep: true },
		},
		{
			type: "run.start",
			run_id: "run",
			session_id: "session",
			ts: OLD,
			input: { type: "text", text: "retained question" },
		},
		{
			type: "llm.request",
			run_id: "run",
			ts: OLD,
			seq: 1,
			model: { provider: "endpoint_a", name: "shared-model" },
			input: {
				messages: [
					{
						role: "user",
						content: `data:image/png;base64,${"A".repeat(requestBytes)}`,
					},
				],
			},
		},
		{
			type: "llm.response",
			run_id: "run",
			ts: OLD,
			seq: 1,
			output: {
				messages: [
					{ role: "assistant", content: "diagnostic-response-sentinel" },
				],
				usage: {
					model: "shared-model",
					input_tokens: 17,
					output_tokens: 3,
					total_tokens: 20,
				},
				provider_meta: { opaque: "diagnostic-provider-sentinel" },
			},
		},
		{
			type: "tool.output",
			run_id: "run",
			ts: OLD,
			tool: "read",
			tool_call_id: "call",
			result_raw: "diagnostic-tool-sentinel",
		},
		{
			type: "agent.event",
			run_id: "run",
			ts: OLD,
			seq: 1,
			event: { type: "final", content: "retained answer 日本語" },
		},
		{ type: "run.end", run_id: "run", ts: OLD, outcome: "completed" },
	];
	const eventLine = `${JSON.stringify(records[5])}\r\n`;
	const source = records
		.map((record, index) =>
			index === 5 ? eventLine : `${JSON.stringify(record)}\n`,
		)
		.join("");
	const plain = path.join(paths.sessionsDir, "2026", "10", "01", "run.jsonl");
	const file = format === "gzip" ? `${plain}.gz` : plain;
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, format === "gzip" ? gzipSync(source) : source);
	await fs.utimes(file, new Date(OLD), new Date(OLD));
	const reference = path.join(paths.toolOutputCacheDir, "keep.txt");
	await fs.mkdir(path.dirname(reference), { recursive: true });
	await fs.writeFile(reference, "retained reference bytes");
	const originalFile = path.join(
		paths.sessionsDir,
		"messages",
		"session.jsonl",
	);
	return {
		paths,
		sessions,
		snapshot,
		file,
		plain,
		source,
		eventLine,
		reference,
		originalFile,
		records,
	};
}

for (const format of ["plain", "gzip"] as const)
	test(`archival removes oversized diagnostics from ${format} and retains conversation, usage and resume data`, async () => {
		const f = await fixture(format, 24 * 1024 * 1024);
		const original = await fs.readFile(f.originalFile);
		const result = await cleanupRunLogs({
			paths: f.paths,
			sessions: f.sessions,
			now: NOW,
		});
		expect(result.compressed).toBe(1);
		expect(result.failed).toBe(0);
		const archive = `${f.plain}.gz`;
		const content = gunzipSync(await fs.readFile(archive)).toString("utf8");
		const records = content
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(content).toContain(f.eventLine);
		expect(records.map((record) => record.type)).toEqual([
			"header",
			"run.start",
			"agent.event",
			"run.end",
			"llm.usage",
		]);
		for (const text of ["diagnostic-", "data:image", '"prompts"', '"tools"'])
			expect(content).not.toContain(text);
		expect(records[0].meta).toEqual({
			keep: true,
			codelia_log_archive_version: 1,
		});
		expect(records[4].model).toEqual({
			provider: "endpoint_a",
			name: "shared-model",
		});
		expect(records[4].output.usage.total_tokens).toBe(20);
		expect((await fs.stat(archive)).mtimeMs).toBe(Date.parse(OLD));
		expect(await f.sessions.load("session")).toEqual(f.snapshot);
		expect(await fs.readFile(f.originalFile)).toEqual(original);
		expect(await fs.readFile(f.reference, "utf8")).toBe(
			"retained reference bytes",
		);
		const before = await fs.readFile(archive);
		const repeated = await cleanupRunLogs({
			paths: f.paths,
			sessions: f.sessions,
			now: NOW,
		});
		expect(repeated.compressed).toBe(0);
		expect(repeated.failed).toBe(0);
		expect(await fs.readFile(archive)).toEqual(before);
	});

for (const existingUsage of [false, true])
	test(`legacy child request identity survives diagnostic removal with existing usage=${existingUsage}`, async () => {
		const f = await fixture("gzip");
		const lines = f.records
			.map((record) => {
				if (record.type === "header") {
					const { model: _model, ...header } = record;
					return header;
				}
				if (record.type === "llm.request")
					return {
						type: record.type,
						run_id: record.run_id,
						ts: record.ts,
						input: {
							messages: [
								{ role: "user", content: "A".repeat(4 * 1024 * 1024) },
							],
						},
						seq: record.seq,
						model: record.model,
					};
				return record;
			})
			.map((record) => JSON.stringify(record))
			.join("\n");
		const raw = `${lines}\n`;
		await fs.writeFile(f.file, gzipSync(raw));
		await fs.utimes(f.file, new Date(OLD), new Date(OLD));
		const usage = path.join(
			f.paths.root,
			"usage",
			"2026",
			"10",
			"01",
			"run.jsonl",
		);
		if (existingUsage) {
			await fs.mkdir(path.dirname(usage), { recursive: true });
			await fs.writeFile(
				usage,
				`${JSON.stringify({ type: "llm.usage", run_id: "run", session_id: "session", ts: OLD, seq: 1, model: { name: "shared-model" }, output: { usage: { model: "shared-model", input_tokens: 17, output_tokens: 3, total_tokens: 20 } } })}\n`,
			);
		}
		const result = await cleanupRunLogs({
			paths: f.paths,
			sessions: f.sessions,
			now: NOW,
		});
		expect(result.compressed).toBe(1);
		expect(result.failed).toBe(0);
		const stored = JSON.parse((await fs.readFile(usage, "utf8")).trim());
		expect(stored.model).toEqual({
			provider: "endpoint_a",
			name: "shared-model",
		});
		const records = gunzipSync(await fs.readFile(f.file))
			.toString("utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(records.filter((record) => record.type === "llm.usage")).toEqual([
			stored,
		]);
	});

test("legacy gzip migration keeps canonical usage instead of a diagnostic response", async () => {
	const f = await fixture("gzip");
	const canonical: LlmUsageRecord = {
		type: "llm.usage",
		run_id: "run",
		session_id: "session",
		ts: OLD,
		seq: 1,
		model: { provider: "endpoint_b", name: "canonical-model" },
		output: {
			usage: {
				model: "canonical-model",
				input_tokens: 2,
				output_tokens: 1,
				total_tokens: 3,
			},
		},
	};
	const usage = path.join(
		f.paths.root,
		"usage",
		"2026",
		"10",
		"01",
		"run.jsonl",
	);
	await fs.mkdir(path.dirname(usage), { recursive: true });
	await fs.writeFile(usage, `${JSON.stringify(canonical)}\n`);
	expect(
		(await cleanupRunLogs({ paths: f.paths, sessions: f.sessions, now: NOW }))
			.compressed,
	).toBe(1);
	const records = gunzipSync(await fs.readFile(f.file))
		.toString("utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	expect(records.filter((record) => record.type === "llm.usage")).toEqual([
		canonical,
	]);
	expect(JSON.parse((await fs.readFile(usage, "utf8")).trim())).toEqual(
		canonical,
	);
});

for (const change of ["pin", "source"] as const)
	test(`legacy gzip is retained when ${change} changes before the guarded commit`, async () => {
		const f = await fixture("gzip");
		let expected = await fs.readFile(f.file);
		const guard = f.sessions.withRetentionGuard.bind(f.sessions);
		f.sessions.withRetentionGuard = async (id, action) => {
			f.sessions.withRetentionGuard = guard;
			if (change === "pin")
				await f.sessions.updateMetadata(id, { pinned: true });
			else {
				await fs.appendFile(f.file, "changed after preparation");
				expected = await fs.readFile(f.file);
			}
			return guard(id, action);
		};
		const result = await cleanupRunLogs({
			paths: f.paths,
			sessions: f.sessions,
			now: NOW,
		});
		expect(result.compressed).toBe(0);
		expect(result.skipped).toBe(1);
		expect(await fs.readFile(f.file)).toEqual(expected);
		expect(await fs.readdir(path.dirname(f.file))).toEqual(["run.jsonl.gz"]);
	});

for (const damage of ["gzip", "incomplete"] as const)
	test(`a ${damage} source failure retains the original diagnostic log`, async () => {
		const f = await fixture(damage === "gzip" ? "gzip" : "plain");
		const bytes = await fs.readFile(f.file);
		if (damage === "gzip") bytes[bytes.length - 8] ^= 1;
		await fs.writeFile(
			f.file,
			damage === "gzip" ? bytes : bytes.subarray(0, -1),
		);
		await fs.utimes(f.file, new Date(OLD), new Date(OLD));
		const before = await fs.readFile(f.file);
		const result = await cleanupRunLogs({
			paths: f.paths,
			sessions: f.sessions,
			now: NOW,
		});
		expect(result.compressed).toBe(0);
		expect(await fs.readFile(f.file)).toEqual(before);
		expect(
			(await fs.readdir(path.dirname(f.file))).some((name) =>
				name.endsWith(".tmp"),
			),
		).toBe(false);
	});
