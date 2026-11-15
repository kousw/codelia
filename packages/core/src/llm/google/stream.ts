import type { ChatInvokeCompletion } from "../../types/llm/invoke";
import type { ChatStreamDeltaSink } from "../base";
import { createProviderResponseError } from "../error-diagnostics";
import { LlmStreamTiming } from "../stream-timing";
import { fromGoogleInteraction } from "./serializer";

type Obj = Record<string, unknown>;
const record = (value: unknown): Obj | null =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Obj)
		: null;

const hasText = (value: unknown): boolean =>
	Array.isArray(value) &&
	value.some((part) => {
		const text = record(part);
		return (
			text?.type === "text" &&
			typeof text.text === "string" &&
			text.text.length > 0
		);
	});

function appendText(
	step: Obj,
	field: "content" | "summary",
	value: string,
): void {
	if (!Array.isArray(step[field])) step[field] = [];
	const parts = step[field] as Obj[];
	const last = record(parts.at(-1));
	if (last?.type === "text" && typeof last.text === "string")
		last.text += value;
	else parts.push({ type: "text", text: value });
}

/** Require a terminal event and every step.stop before exposing output. */
export async function collectGoogleStream(
	stream: AsyncIterable<unknown>,
	model: string,
	onDelta?: ChatStreamDeltaSink,
	timing = new LlmStreamTiming(),
): Promise<ChatInvokeCompletion> {
	// Provisional deltas: one assistant text per `model_output` step and one
	// reasoning text per `thought` step; the per-kind ordinal is assigned at
	// step.start in step order. It groups deltas only (see ChatStreamDelta).
	const deltaIndex = new Map<number, number>();
	const kindCounts = { text: 0, reasoning: 0 };
	const steps = new Map<
		number,
		{ value: Obj; stopped: boolean; argumentsDelta: string }
	>();
	let completed: Obj | null = null;
	for await (const raw of stream) {
		const event = record(raw);
		if (!event) throw createProviderResponseError("google", "invalid_event");
		const kind = event.event_type;
		if (kind === "interaction.created" || kind === "interaction.status_update")
			continue;
		if (kind === "interaction.completed") {
			if (completed || !record(event.interaction))
				throw createProviderResponseError("google", "invalid_completion");
			completed = record(event.interaction);
			timing.complete();
			continue;
		}
		if (completed)
			throw createProviderResponseError("google", "after_completion");
		const index = event.index;
		if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0)
			throw createProviderResponseError("google", "invalid_step_index");
		if (kind === "step.start") {
			const step = record(event.step);
			if (!step || steps.has(index))
				throw createProviderResponseError("google", "invalid_step");
			steps.set(index, {
				value: structuredClone(step),
				stopped: false,
				argumentsDelta: "",
			});
			if (step.type === "thought") timing.observeReasoningStart("thought_step");
			// Some streams supply content in step.start instead of step.delta.
			const args = record(step.arguments);
			if (
				(step.type === "model_output" && hasText(step.content)) ||
				(step.type === "thought" && hasText(step.summary)) ||
				(step.type === "function_call" &&
					args !== null &&
					Object.keys(args).length > 0)
			)
				timing.observeOutput();
			if (onDelta && (step.type === "model_output" || step.type === "thought"))
				deltaIndex.set(
					index,
					kindCounts[step.type === "thought" ? "reasoning" : "text"]++,
				);
			continue;
		}
		const current = steps.get(index);
		if (!current || current.stopped)
			throw createProviderResponseError("google", "out_of_order");
		if (kind === "step.stop") {
			if (current.argumentsDelta) {
				let args: unknown;
				try {
					args = JSON.parse(current.argumentsDelta);
				} catch {
					throw createProviderResponseError("google", "invalid_tool_arguments");
				}
				if (!record(args))
					throw createProviderResponseError("google", "invalid_tool_arguments");
				current.value.arguments = args;
			}
			current.stopped = true;
			continue;
		}
		if (kind !== "step.delta")
			throw createProviderResponseError("google", "unsupported_event");
		const delta = record(event.delta);
		if (!delta) throw createProviderResponseError("google", "invalid_delta");
		if (
			delta.type === "text" &&
			current.value.type === "model_output" &&
			typeof delta.text === "string"
		) {
			appendText(current.value, "content", delta.text);
			if (delta.text) {
				timing.observeOutput();
				const ordinal = deltaIndex.get(index);
				if (onDelta && ordinal !== undefined)
					onDelta({ kind: "text", index: ordinal, delta: delta.text });
			}
		} else if (
			delta.type === "arguments_delta" &&
			current.value.type === "function_call" &&
			typeof delta.arguments === "string"
		) {
			current.argumentsDelta += delta.arguments;
			if (delta.arguments) timing.observeOutput();
		} else if (
			delta.type === "thought_signature" &&
			current.value.type === "thought" &&
			typeof delta.signature === "string"
		) {
			current.value.signature = delta.signature;
		} else if (
			delta.type === "thought_summary" &&
			current.value.type === "thought"
		) {
			const content = record(delta.content);
			if (content?.type !== "text" || typeof content.text !== "string")
				throw createProviderResponseError("google", "unsupported_content");
			appendText(current.value, "summary", content.text);
			if (content.text) {
				timing.observeOutput();
				const ordinal = deltaIndex.get(index);
				if (onDelta && ordinal !== undefined)
					onDelta({ kind: "reasoning", index: ordinal, delta: content.text });
			}
		} else {
			throw createProviderResponseError("google", "unsupported_delta");
		}
	}
	if (!completed || [...steps.values()].some((step) => !step.stopped))
		throw createProviderResponseError("google", "incomplete");
	const ordered = [...steps.entries()].sort(([a], [b]) => a - b);
	if (ordered.some(([index], position) => index !== position))
		throw createProviderResponseError("google", "missing_step");
	const result = fromGoogleInteraction(
		{ ...completed, steps: ordered.map(([, step]) => step.value) },
		model,
	);
	const measured = timing.finish();
	return measured ? { ...result, timing: measured } : result;
}
