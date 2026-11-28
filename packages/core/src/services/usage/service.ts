import type { ChatInvokeUsage } from "../../types/llm/invoke";
import type { TokenUsageConfig } from "./config";

export type UsageByModel = {
	calls: number;
	input_tokens: number;
	output_tokens: number;
	output_reasoning_tokens: number;
	cached_input_tokens: number;
	cache_creation_tokens: number;
	input_image_tokens: number;
	cache_hit_calls: number;
	cache_miss_calls: number;
	cache_unknown_calls: number;
	total_tokens: number;
	cost_usd?: number | null;
};

export type UsageSummary = {
	total_calls: number;
	total_tokens: number;
	total_input_tokens: number;
	total_output_tokens: number;
	total_output_reasoning_tokens: number;
	total_cached_input_tokens: number;
	total_cache_creation_tokens: number;
	total_input_image_tokens: number;
	cache_hit_calls: number;
	cache_miss_calls: number;
	cache_unknown_calls: number;
	total_cost_usd?: number | null;
	by_model: Record<string, UsageByModel>;
};

export class TokenUsageService {
	private usageSummary: UsageSummary;
	private lastUsage: ChatInvokeUsage | null = null;
	constructor(private readonly config: TokenUsageConfig) {
		this.usageSummary = {
			total_calls: 0,
			total_tokens: 0,
			total_input_tokens: 0,
			total_output_tokens: 0,
			total_output_reasoning_tokens: 0,
			total_cached_input_tokens: 0,
			total_cache_creation_tokens: 0,
			total_input_image_tokens: 0,
			cache_hit_calls: 0,
			cache_miss_calls: 0,
			cache_unknown_calls: 0,
			total_cost_usd: null,
			by_model: {},
		};
	}

	updateUsageSummary(
		usage: ChatInvokeUsage | null | undefined,
		costUsd?: number | null,
	): void {
		// update last usage
		this.lastUsage = usage ?? null;

		if (!this.config.enabled || !usage) {
			return;
		}

		const hasCacheMetric = typeof usage.input_cached_tokens === "number";
		const cached = hasCacheMetric ? (usage.input_cached_tokens ?? 0) : 0;
		const cacheCreation = usage.input_cache_creation_tokens ?? 0;
		const reasoning = usage.output_reasoning_tokens ?? 0;
		const image = usage.input_image_tokens ?? 0;
		const cacheState: "hit" | "miss" | "unknown" = hasCacheMetric
			? cached > 0
				? "hit"
				: "miss"
			: "unknown";
		const validCost =
			typeof costUsd === "number" && Number.isFinite(costUsd) && costUsd >= 0
				? costUsd
				: null;

		this.usageSummary.total_calls++;
		this.usageSummary.total_tokens += usage.total_tokens;
		this.usageSummary.total_input_tokens += usage.input_tokens;
		this.usageSummary.total_output_tokens += usage.output_tokens;
		this.usageSummary.total_output_reasoning_tokens += reasoning;
		this.usageSummary.total_cached_input_tokens += cached;
		this.usageSummary.total_cache_creation_tokens += cacheCreation;
		this.usageSummary.total_input_image_tokens += image;
		if (cacheState === "hit") {
			this.usageSummary.cache_hit_calls++;
		} else if (cacheState === "miss") {
			this.usageSummary.cache_miss_calls++;
		} else {
			this.usageSummary.cache_unknown_calls++;
		}
		if (validCost !== null) {
			this.usageSummary.total_cost_usd =
				(this.usageSummary.total_cost_usd ?? 0) + validCost;
		}

		const model = usage.model ?? "unknown";
		const bucket = this.usageSummary.by_model[model];
		if (!bucket) {
			this.usageSummary.by_model[model] = {
				calls: 1,
				input_tokens: usage.input_tokens,
				output_tokens: usage.output_tokens,
				output_reasoning_tokens: reasoning,
				cached_input_tokens: cached,
				cache_creation_tokens: cacheCreation,
				input_image_tokens: image,
				cache_hit_calls: cacheState === "hit" ? 1 : 0,
				cache_miss_calls: cacheState === "miss" ? 1 : 0,
				cache_unknown_calls: cacheState === "unknown" ? 1 : 0,
				total_tokens: usage.total_tokens,
				cost_usd: validCost,
			};
		} else {
			bucket.calls++;
			bucket.input_tokens += usage.input_tokens;
			bucket.output_tokens += usage.output_tokens;
			bucket.output_reasoning_tokens += reasoning;
			bucket.cached_input_tokens += cached;
			bucket.cache_creation_tokens += cacheCreation;
			bucket.input_image_tokens += image;
			if (cacheState === "hit") {
				bucket.cache_hit_calls++;
			} else if (cacheState === "miss") {
				bucket.cache_miss_calls++;
			} else {
				bucket.cache_unknown_calls++;
			}
			bucket.total_tokens += usage.total_tokens;
			if (validCost !== null) {
				bucket.cost_usd = (bucket.cost_usd ?? 0) + validCost;
			}
		}
	}

	getUsageSummary(): UsageSummary {
		return this.usageSummary;
	}

	getLastUsage(): ChatInvokeUsage | null {
		return this.lastUsage;
	}
}
