import {
	estimateUsageCostUsd,
	type LlmResponseRecord,
	type ModelCost,
} from "@codelia/core";
import type {
	RunContextSnapshot,
	RunMetricsNotify,
} from "@codelia/protocol";
import { summarizeProviderMeta } from "./run-debug";

export type PendingLlmRequestMeta = {
	ts: string;
	provider?: string;
	model?: string;
};

export type BuildCallRunMetricsInput = {
	record: LlmResponseRecord;
	request?: PendingLlmRequestMeta;
	latencyMs: number;
	metered: boolean;
	getModelCost?: (model: string) => ModelCost | undefined;
	retryCount: number;
	retryWaitMs: number;
	context?: RunContextSnapshot;
};

const nonEmpty = (value?: string | null): string | undefined =>
	typeof value === "string" && value.trim().length > 0
		? value.trim()
		: undefined;

const extractActualModel = (providerMeta: unknown): string | null => {
	const meta = providerMeta as
		| {
				server_model?: unknown;
				codex_metadata?: { server_model?: unknown };
		  }
		| undefined;
	const rawServerModel =
		meta?.codex_metadata?.server_model ?? meta?.server_model;
	return typeof rawServerModel === "string" && rawServerModel.trim().length > 0
		? rawServerModel.trim()
		: null;
};

export const buildRunMetrics = (
	record: LlmResponseRecord,
): RunMetricsNotify => {
	const timing = record.output.timing;
	const tokens = record.output.usage?.output_tokens;
	const duration = timing?.generation_duration_ms;
	const reasoning = record.output.usage?.output_reasoning_tokens;
	const matchedReasoning =
		reasoning === undefined ||
		reasoning === null ||
		(Number.isFinite(reasoning) &&
			reasoning >= 0 &&
			reasoning <= (tokens ?? 0) &&
			(reasoning === 0 ||
				((timing?.generation_start_source === "reasoning_item" ||
					timing?.generation_start_source === "thought_step") &&
					typeof timing.generation_start_ms === "number")));
	const validTiming =
		timing &&
		Number.isFinite(timing.time_to_first_token_ms) &&
		timing.time_to_first_token_ms >= 0 &&
		typeof duration === "number" &&
		Number.isFinite(duration) &&
		duration >= 0 &&
		(timing.generation_start_ms === undefined ||
			(Number.isFinite(timing.generation_start_ms) &&
				timing.generation_start_ms >= 0 &&
				timing.generation_start_ms <= timing.time_to_first_token_ms));
	const rate =
		validTiming &&
		matchedReasoning &&
		typeof tokens === "number" &&
		Number.isFinite(tokens) &&
		tokens >= 0 &&
		// Very short/batched streams do not expose a useful generation interval.
		duration >= 250
			? (tokens * 1000) / duration
			: null;
	return {
		run_id: record.run_id,
		seq: record.seq,
		output_tokens_per_second:
			rate !== null && Number.isFinite(rate) ? rate : null,
		...(validTiming ? { timing } : {}),
	};
};

export const buildCallRunMetrics = (
	input: BuildCallRunMetricsInput,
): RunMetricsNotify => {
	const { record, request } = input;
	const usage = record.output.usage ?? null;
	const hasCacheMetric = typeof usage?.input_cached_tokens === "number";
	const cacheReadTokens = hasCacheMetric
		? (usage?.input_cached_tokens ?? 0)
		: 0;
	const cacheCreationTokens = usage?.input_cache_creation_tokens ?? 0;
	const inputTokens = usage?.input_tokens ?? 0;
	const hitState = hasCacheMetric
		? cacheReadTokens > 0
			? "hit"
			: "miss"
		: "unknown";
	const requestModel = nonEmpty(request?.model);
	const usageModel = nonEmpty(usage?.model);
	const model = usageModel ?? requestModel ?? "unknown";
	const baseMetrics = buildRunMetrics(record);
	const modelCost = input.getModelCost
		? (requestModel ? input.getModelCost(requestModel) : undefined) ??
			input.getModelCost(model)
		: undefined;
	const costUsd = input.metered ? estimateUsageCostUsd(usage, modelCost) : null;
	const actualModel = extractActualModel(record.output.provider_meta);

	return {
		...baseMetrics,
		...(request?.provider ? { provider: request.provider } : {}),
		model,
		...(actualModel ? { actual_model: actualModel } : {}),
		request_ts: request?.ts ?? record.ts,
		response_ts: record.ts,
		latency_ms: Math.max(0, Math.round(input.latencyMs)),
		stop_reason: record.output.stop_reason ?? null,
		usage,
		cache: {
			hit_state: hitState,
			cache_read_tokens: cacheReadTokens,
			cache_creation_tokens: cacheCreationTokens,
			cache_read_ratio:
				hasCacheMetric && inputTokens > 0
					? Math.min(1, Math.max(0, cacheReadTokens / inputTokens))
					: null,
		},
		cost_usd: costUsd,
		cost_basis: costUsd !== null ? "api_list" : "unavailable",
		retry_count: Math.max(0, input.retryCount),
		retry_wait_ms: Math.max(0, input.retryWaitMs),
		provider_meta_summary: summarizeProviderMeta(record.output.provider_meta),
		...(input.context ? { context: input.context } : {}),
	};
};
