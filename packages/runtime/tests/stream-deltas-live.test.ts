import { describe, expect, test } from "bun:test";
import { Agent, type AgentEvent, defineTool } from "@codelia/core";
import { z } from "zod";
import { createRuntimeModel } from "../src/model-factory";

// Live smoke for opt-in provisional deltas (chargeable). Keys come from the
// environment only; auth is passed explicitly, so nothing is read from or
// written to ~/.codelia.
//
//   INTEGRATION=1 CODELIA_TEST_STREAM_DELTA_LIVE=1 \
//     bun test packages/runtime/tests/stream-deltas-live.test.ts
//
// Optional: CODELIA_TEST_STREAM_DELTA_LIVE_PROVIDERS=anthropic,google limits providers;
// CODELIA_TEST_STREAM_DELTA_LIVE_MODEL_<PROVIDER>=<model> overrides a provider default.

type LiveProvider =
	| "openai"
	| "anthropic"
	| "google"
	| "openrouter"
	| "deepseek"
	| "xai"
	| "zai"
	| "moonshot";

const PROVIDERS: Array<{
	provider: LiveProvider;
	keyEnv: string;
	model?: string;
}> = [
	{ provider: "openai", keyEnv: "OPENAI_API_KEY" },
	{ provider: "anthropic", keyEnv: "ANTHROPIC_API_KEY" },
	{ provider: "google", keyEnv: "GEMINI_API_KEY" },
	{
		provider: "openrouter",
		keyEnv: "OPENROUTER_API_KEY",
		model: "openai/gpt-5.6",
	},
	{ provider: "deepseek", keyEnv: "DEEPSEEK_API_KEY" },
	{ provider: "xai", keyEnv: "XAI_API_KEY" },
	{ provider: "zai", keyEnv: "ZAI_API_KEY" },
	{ provider: "moonshot", keyEnv: "MOONSHOT_API_KEY" },
];

const live =
	process.env.INTEGRATION === "1" &&
	process.env.CODELIA_TEST_STREAM_DELTA_LIVE === "1";
const selected = (process.env.CODELIA_TEST_STREAM_DELTA_LIVE_PROVIDERS ?? "")
	.split(",")
	.map((value) => value.trim())
	.filter(Boolean);

const PROMPT =
	'Think briefly first. Then write one short sentence saying you will call the tool, and call smoke_echo once with value="verified". After the tool result, reply with two short sentences that mention the returned value.';

const echoTool = defineTool({
	name: "smoke_echo",
	description: "Echoes a supplied test value without side effects.",
	input: z.object({ value: z.string() }),
	execute: ({ value }) => `echo:${value}`,
});

type DeltaEvent = Extract<
	AgentEvent,
	{ type: "text.delta" | "reasoning.delta" }
>;

const isDelta = (event: AgentEvent): event is DeltaEvent =>
	event.type === "text.delta" || event.type === "reasoning.delta";

type Segment = {
	streams: string[];
	text: string[][];
	reasoning: string[][];
	completeText: string[];
	completeReasoning: string[];
	final?: string;
};

/**
 * Splits the event list into model steps (ending at the first tool_call of a
 * step, or at final) and checks the delivery invariants. Returns alignment
 * mismatches separately so the summary can report every provider difference.
 */
const analyze = (events: AgentEvent[]) => {
	const violations: string[] = [];
	const segments: Segment[] = [];
	const closed = new Set<string>();
	const discarded = new Set<string>();
	const open = new Set<string>();
	let segment: Segment = {
		streams: [],
		text: [],
		reasoning: [],
		completeText: [],
		completeReasoning: [],
	};
	let inToolCalls = false;
	const blocks = new Map<
		string,
		{ kind: string; index: number; text: string }
	>();

	const closeSegment = () => {
		for (const stream of segment.streams) {
			if (discarded.has(stream)) continue;
			const byKind = (kind: string) =>
				[...blocks.entries()]
					.filter(
						([key, block]) =>
							key.startsWith(`${stream}:`) && block.kind === kind,
					)
					.map(([, block]) => block)
					.sort((a, b) => a.index - b.index);
			segment.text.push(byKind("text").map((block) => block.text));
			segment.reasoning.push(byKind("reasoning").map((block) => block.text));
		}
		segments.push(segment);
		segment = {
			streams: [],
			text: [],
			reasoning: [],
			completeText: [],
			completeReasoning: [],
		};
	};

	for (const event of events) {
		if (isDelta(event)) {
			inToolCalls = false;
			if (typeof event.stream_id !== "string" || !event.stream_id)
				violations.push("delta without stream_id");
			if (!Number.isInteger(event.index) || event.index < 0)
				violations.push(`invalid index ${String(event.index)}`);
			if (event.delta.length === 0) violations.push("empty delta");
			if (closed.has(event.stream_id))
				violations.push(
					`delta for ${event.stream_id} arrived after a later event`,
				);
			if (!segment.streams.includes(event.stream_id)) {
				if (segments.some((s) => s.streams.includes(event.stream_id)))
					violations.push(`stream_id ${event.stream_id} reused across steps`);
				segment.streams.push(event.stream_id);
			}
			open.add(event.stream_id);
			const kind = event.type === "text.delta" ? "text" : "reasoning";
			const key = `${event.stream_id}:${kind}:${event.index}`;
			const block = blocks.get(key) ?? { kind, index: event.index, text: "" };
			block.text += event.delta;
			blocks.set(key, block);
			continue;
		}
		if (event.type === "llm.status") continue;
		for (const stream of open) closed.add(stream);
		if (event.type === "llm.retry")
			for (const stream of open) discarded.add(stream);
		open.clear();
		if (event.type === "reasoning")
			segment.completeReasoning.push(event.content);
		if (event.type === "text") segment.completeText.push(event.content);
		if (event.type === "tool_call") {
			if (!inToolCalls) closeSegment();
			inToolCalls = true;
			continue;
		}
		if (event.type === "final") {
			segment.final = event.content;
			closeSegment();
			continue;
		}
		if (
			event.type !== "tool_result" &&
			event.type !== "step_start" &&
			event.type !== "step_complete"
		)
			inToolCalls = false;
	}

	const mismatches: string[] = [];
	segments.forEach((seg, i) => {
		const live = seg.streams.filter((stream) => !discarded.has(stream));
		if (live.length > 1)
			violations.push(`step ${i}: ${live.length} live streams in one step`);
		const provisionalText = seg.text[0] ?? [];
		const provisionalReasoning = seg.reasoning[0] ?? [];
		const expectedText =
			seg.final !== undefined ? [seg.final] : seg.completeText;
		const gotText =
			seg.final !== undefined
				? provisionalText.length
					? [provisionalText.join("\n")]
					: []
				: provisionalText;
		const short = (values: string[]) =>
			JSON.stringify(
				values.map((v) => (v.length > 60 ? `${v.slice(0, 60)}…` : v)),
			);
		if (
			gotText.length &&
			JSON.stringify(gotText) !== JSON.stringify(expectedText)
		)
			mismatches.push(
				`step ${i} text: deltas ${short(gotText)} vs complete ${short(expectedText)}`,
			);
		if (
			provisionalReasoning.length &&
			JSON.stringify(provisionalReasoning) !==
				JSON.stringify(seg.completeReasoning)
		)
			mismatches.push(
				`step ${i} reasoning: deltas ${short(provisionalReasoning)} vs complete ${short(seg.completeReasoning)}`,
			);
	});
	return { violations, mismatches, segments };
};

describe("live provisional deltas (chargeable)", () => {
	for (const entry of PROVIDERS) {
		// Trimmed like the runtime's readEnvValue.
		const apiKey = process.env[entry.keyEnv]?.trim() || undefined;
		const enabled =
			live &&
			!!apiKey &&
			(selected.length === 0 || selected.includes(entry.provider));
		(enabled ? test : test.skip)(
			`${entry.provider}: deltas are well-formed, ordered and never reused across steps`,
			async () => {
				const model =
					process.env[
						`CODELIA_TEST_STREAM_DELTA_LIVE_MODEL_${entry.provider.toUpperCase()}`
					] ?? entry.model;
				const { llm } = await createRuntimeModel({
					provider: entry.provider,
					config: { ...(model ? { name: model } : {}), reasoning: "low" },
					auth: { method: "api_key", api_key: apiKey ?? "" },
					useMetadata: false,
					log: () => {},
				});
				const agent = new Agent({
					llm,
					tools: [echoTool],
					compaction: null,
					toolOutputCache: null,
					maxIterations: 4,
				});
				const events: AgentEvent[] = [];
				for await (const event of agent.runStream(PROMPT, {
					streamDeltas: true,
					signal: AbortSignal.timeout(170_000),
				}))
					events.push(event);

				const { violations, mismatches, segments } = analyze(events);
				const deltas = events.filter(isDelta);
				console.log(
					`[stream-deltas-live] ${entry.provider} (${llm.model}): ` +
						JSON.stringify({
							steps: segments.length,
							deltas: deltas.length,
							text_deltas: deltas.filter((e) => e.type === "text.delta").length,
							reasoning_deltas: deltas.filter(
								(e) => e.type === "reasoning.delta",
							).length,
							streams: new Set(deltas.map((e) => e.stream_id)).size,
							retries: events.filter((e) => e.type === "llm.retry").length,
							violations,
							mismatches,
						}),
				);
				expect(events.at(-1)?.type).toBe("final");
				expect(deltas.length).toBeGreaterThan(0);
				expect(violations).toEqual([]);
				// `index` does not identify complete events (ui-protocol.md §5.2), so
				// provider-specific mismatches are reported, not asserted.
			},
			180_000,
		);
	}
});
