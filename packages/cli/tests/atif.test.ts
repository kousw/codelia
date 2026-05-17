import { describe, expect, test } from "bun:test";
import { parseSessionJsonl, sessionRecordsToAtif } from "../src/atif";

describe("sessionRecordsToAtif", () => {
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
});
