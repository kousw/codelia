import type { LlmCallTiming } from "@codelia/shared-types";

const record = (value: unknown): Record<string, unknown> | undefined =>
	value !== null && typeof value === "object"
		? (value as Record<string, unknown>)
		: undefined;
const nonempty = (value: unknown): boolean =>
	typeof value === "string" && value.length > 0;

const responseOutputDeltas = new Set([
	"response.output_text.delta",
	"response.refusal.delta",
	"response.function_call_arguments.delta",
	"response.custom_tool_call_input.delta",
	"response.reasoning_text.delta",
	"response.reasoning_summary_text.delta",
]);

/** One instance per transport attempt; no payload retention or token estimation. */
export class LlmStreamTiming {
	private readonly startedAt: number;
	private firstOutputAt?: number;
	private reasoningStartedAt?: number;
	private completedAt?: number;

	constructor(private readonly nowMs: () => number = () => performance.now()) {
		this.startedAt = nowMs();
	}

	observeOutput(): void {
		if (this.completedAt === undefined && this.firstOutputAt === undefined)
			this.firstOutputAt = this.nowMs();
	}

	complete(): void {
		this.completedAt ??= this.nowMs();
	}

	observeResponsesEvent(event: unknown): void {
		const value = record(event);
		if (!value) return;
		// A Responses reasoning item marks observed generation activity before
		// hidden tokens or a summary become visible. Do not start on created/role
		// events, metadata, or an empty assistant item.
		if (
			value.type === "response.output_item.added" &&
			record(value.item)?.type === "reasoning" &&
			this.completedAt === undefined
		)
			this.reasoningStartedAt ??= this.nowMs();
		if (responseOutputDeltas.has(String(value.type)) && nonempty(value.delta))
			this.observeOutput();
		if (
			value.type === "response.completed" ||
			value.type === "response.incomplete" ||
			value.type === "response.done"
		)
			this.complete();
	}

	observeChatChunk(chunk: unknown): void {
		const choices = record(chunk)?.choices;
		if (!Array.isArray(choices)) return;
		for (const choice of choices) {
			const delta = record(record(choice)?.delta);
			if (!delta) continue;
			if (
				nonempty(delta.content) ||
				nonempty(delta.reasoning_content) ||
				nonempty(delta.reasoning) ||
				(Array.isArray(delta.tool_calls) &&
					delta.tool_calls.some((tool) =>
						nonempty(record(record(tool)?.function)?.arguments),
					))
			)
				this.observeOutput();
		}
	}

	observeAnthropicEvent(event: unknown): void {
		const value = record(event);
		if (!value) return;
		const delta = record(value.delta);
		if (
			value.type === "content_block_delta" &&
			(nonempty(delta?.text) ||
				nonempty(delta?.thinking) ||
				nonempty(delta?.partial_json))
		)
			this.observeOutput();
		if (value.type === "message_stop") this.complete();
	}

	finish(): LlmCallTiming | undefined {
		this.complete();
		if (this.firstOutputAt === undefined) return undefined;
		const first = this.firstOutputAt - this.startedAt;
		const start = Math.min(
			this.firstOutputAt,
			this.reasoningStartedAt ?? this.firstOutputAt,
		);
		const generation = (this.completedAt as number) - start;
		if (
			![first, generation, start - this.startedAt].every(
				(ms) => Number.isFinite(ms) && ms >= 0,
			)
		)
			return undefined;
		return {
			time_to_first_token_ms: first,
			generation_duration_ms: generation,
			...(this.reasoningStartedAt !== undefined &&
			start === this.reasoningStartedAt
				? {
						generation_start_ms: start - this.startedAt,
						generation_start_source: "reasoning_item" as const,
					}
				: {}),
		};
	}
}
