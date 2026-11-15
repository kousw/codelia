import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import {
	cleanupRunLogs,
	resolveStoragePaths,
	SessionStateStoreImpl,
} from "@codelia/storage";
import {
	parseSessionJsonl,
	readSessionJsonl,
	sessionRecordsToAtif,
} from "../src/atif";
import { writePromptModeAtif } from "../src/prompt-mode";

describe("sessionRecordsToAtif", () => {
	test("compressed run events retain ATIF conversation and usage, including plain-path fallback", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "codelia-atif-gzip-"));
		try {
			const paths = resolveStoragePaths({ rootOverride: root });
			const sessions = new SessionStateStoreImpl({ paths });
			await sessions.save({
				schema_version: 1,
				session_id: "session",
				updated_at: "2026-10-01",
				messages: [{ role: "user", content: "saved original" }],
			});
			const file = path.join(
				paths.sessionsDir,
				"2026",
				"10",
				"01",
				"run.jsonl",
			);
			await mkdir(path.dirname(file), { recursive: true });
			const records = [
				{
					type: "header",
					schema_version: 1,
					run_id: "run",
					session_id: "session",
					started_at: "2026-10-01",
				},
				{
					type: "run.start",
					input: { type: "text", text: "Original question" },
				},
				{
					type: "agent.event",
					event: { type: "final", content: "Original answer" },
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
					type: "llm.usage",
					run_id: "run",
					ts: "2026-10-01",
					seq: 1,
					output: {
						usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
					},
				},
			];
			await writeFile(
				`${file}.gz`,
				gzipSync(
					`${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
				),
			);
			for (const source of [file, `${file}.gz`]) {
				const atif = sessionRecordsToAtif(
					await readSessionJsonl(source),
					"run",
				);
				expect(atif.steps.at(-1)?.message).toBe("Original answer");
				expect(atif.final_metrics?.total_prompt_tokens).toBe(10);
			}
			await sessions.updateMetadata("session", { archived: true });
			expect((await cleanupRunLogs({ paths, sessions })).compressed).toBe(1);
			const archived = await readSessionJsonl(file);
			const after = sessionRecordsToAtif(archived, "run");
			expect(after.steps.at(-1)?.message).toBe("Original answer");
			expect(after.final_metrics?.total_prompt_tokens).toBe(10);
			expect(after.final_metrics?.total_completion_tokens).toBe(2);
			expect(archived.some((record) => record.type === "llm.request")).toBe(
				false,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	test("compact usage supports opt-in ATIF without a response dump or double counting", () => {
		const records = [
			{ type: "header", session_id: "session", model: { name: "mock" } },
			{ type: "run.start", input: { type: "text", text: "Continue" } },
			{ type: "agent.event", event: { type: "final", content: "Done" } },
			{
				type: "llm.usage",
				seq: 1,
				output: { usage: { input_tokens: 10, output_tokens: 2 } },
			},
			{
				type: "llm.response",
				seq: 1,
				output: { usage: { input_tokens: 10, output_tokens: 2 } },
			},
			{
				type: "llm.response",
				seq: 2,
				output: { usage: { input_tokens: 3, output_tokens: 1 } },
			},
		];
		const atif = sessionRecordsToAtif(records, "run");
		expect(atif.final_metrics?.total_prompt_tokens).toBe(13);
		expect(atif.final_metrics?.total_completion_tokens).toBe(3);
		expect(atif.steps.at(-1)?.message).toBe("Done");
	});
	test("maps session records to Harbor-compatible ATIF-v1.6", () => {
		const trajectory = sessionRecordsToAtif(
			[
				{
					type: "header",
					ts: "2026-05-17T00:00:00.000Z",
					session_id: "session-1",
					model: { name: "gpt-5.5" },
				},
				{
					type: "run.start",
					ts: "2026-05-17T00:00:01.000Z",
					input: { type: "text", text: "solve it" },
				},
				{
					type: "agent.event",
					ts: "2026-05-17T00:00:02.000Z",
					event: {
						type: "tool_call",
						tool_call_id: "call-1",
						tool: "shell.exec",
						args: { cmd: "pwd" },
					},
				},
				{
					type: "agent.event",
					ts: "2026-05-17T00:00:03.000Z",
					event: {
						type: "tool_result",
						tool_call_id: "call-1",
						result: "/app",
					},
				},
				{
					type: "agent.event",
					ts: "2026-05-17T00:00:04.000Z",
					event: { type: "final", content: "done" },
				},
				{
					type: "llm.response",
					output: {
						usage: {
							input_tokens: 100,
							output_tokens: 20,
							input_cached_tokens: 40,
						},
					},
				},
			],
			"run-1",
		);

		expect(trajectory.schema_version).toBe("ATIF-v1.6");
		expect(trajectory.session_id).toBe("session-1");
		expect(trajectory.agent).toEqual({
			name: "codelia",
			version: "unknown",
			model_name: "gpt-5.5",
		});
		expect(trajectory.steps.map((step) => step.step_id)).toEqual([1, 2, 3]);
		expect(trajectory.steps[0]).toMatchObject({
			source: "user",
			message: "solve it",
		});
		expect(trajectory.steps[1]).toMatchObject({
			source: "agent",
			message: "",
			tool_calls: [
				{
					tool_call_id: "call-1",
					function_name: "shell.exec",
					arguments: { cmd: "pwd" },
				},
			],
			observation: {
				results: [{ source_call_id: "call-1", content: "/app" }],
			},
		});
		expect(trajectory.steps[2]).toMatchObject({
			source: "agent",
			message: "done",
		});
		expect(trajectory.final_metrics).toEqual({
			total_prompt_tokens: 100,
			total_completion_tokens: 20,
			total_cached_tokens: 40,
			total_steps: 3,
		});
	});

	test("ignores malformed jsonl lines from partial logs", () => {
		expect(
			parseSessionJsonl('{"type":"header","session_id":"ok"}\nnot-json\n'),
		).toEqual([{ type: "header", session_id: "ok" }]);
	});

	test("writes partial ATIF from session log without final event", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "codelia-atif-"));
		try {
			const sessionLogPath = path.join(dir, "session.jsonl");
			const outPath = path.join(dir, "trajectory.json");
			await writeFile(
				sessionLogPath,
				[
					JSON.stringify({
						type: "header",
						session_id: "session-partial",
						model: { name: "glm-5.2" },
					}),
					JSON.stringify({
						type: "run.start",
						ts: "2026-06-20T00:00:00.000Z",
						input: { type: "text", text: "solve partially" },
					}),
					JSON.stringify({
						type: "llm.response",
						output: {
							usage: {
								input_tokens: 120,
								input_cached_tokens: 100,
								output_tokens: 30,
							},
						},
					}),
					"{malformed",
					"",
				].join("\n"),
				"utf8",
			);

			await expect(
				writePromptModeAtif({
					atifOut: outPath,
					sessionLogPath,
					runId: "run-partial",
				}),
			).resolves.toBe("written");

			const trajectory = JSON.parse(await readFile(outPath, "utf8"));
			expect(trajectory.session_id).toBe("session-partial");
			expect(trajectory.steps).toHaveLength(1);
			expect(trajectory.final_metrics).toEqual({
				total_prompt_tokens: 120,
				total_completion_tokens: 30,
				total_cached_tokens: 100,
				total_steps: 1,
			});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("skips prompt-mode ATIF when no output path is configured", async () => {
		await expect(
			writePromptModeAtif({
				atifOut: undefined,
				sessionLogPath: null,
				runId: null,
			}),
		).resolves.toBe("skipped");
	});

	test("fails prompt-mode ATIF when output path is configured without session metadata", async () => {
		await expect(
			writePromptModeAtif({
				atifOut: "/tmp/trajectory.json",
				sessionLogPath: null,
				runId: null,
			}),
		).rejects.toThrow("session log path is missing");
	});
});
