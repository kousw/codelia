import type { ChatInvokeUsage } from "../../types/llm/invoke";
import type { TokenUsageConfig } from "./config";

export type UsageSummary = {
	total_calls: number;
	total_tokens: number;
	total_input_tokens: number;
	total_output_tokens: number;
	total_cached_input_tokens: number;
	total_cache_creation_tokens: number;
	total_cost_usd?: number | null;
	by_model: Record<
		string,
		{
			calls: number;
			input_tokens: number;
			output_tokens: number;
			cached_input_tokens: number;
			cache_creation_tokens: number;
			total_tokens: number;
			cost_usd?: number | null;
		}
	>;
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
			total_cached_input_tokens: 0,
			total_cache_creation_tokens: 0,
			total_cost_usd: 0,
			by_model: {},
		};
	}

	updateUsageSummary(usage: ChatInvokeUsage | null | undefined): void {
		// update last usage
		this.lastUsage = usage ?? null;

		if (!this.config.enabled || !usage) {
			return;
		}

		this.usageSummary.total_calls++;

		this.usageSummary.total_tokens += usage.total_tokens;
		this.usageSummary.total_input_tokens += usage.input_tokens;
		this.usageSummary.total_output_tokens += usage.output_tokens;
		this.usageSummary.total_cached_input_tokens +=
			usage.input_cached_tokens ?? 0;
		this.usageSummary.total_cache_creation_tokens +=
			usage.input_cache_creation_tokens ?? 0;

		const model = usage.model ?? "unknown";
		if (!this.usageSummary.by_model[model]) {
			this.usageSummary.by_model[model] = {
				calls: 1,
				input_tokens: usage.input_tokens,
				output_tokens: usage.output_tokens,
				cached_input_tokens: usage.input_cached_tokens ?? 0,
				cache_creation_tokens: usage.input_cache_creation_tokens ?? 0,
				total_tokens: usage.total_tokens,
			};
		} else {
			this.usageSummary.by_model[model].calls++;
			this.usageSummary.by_model[model].input_tokens += usage.input_tokens;
			this.usageSummary.by_model[model].output_tokens += usage.output_tokens;
			this.usageSummary.by_model[model].cached_input_tokens +=
				usage.input_cached_tokens ?? 0;
			this.usageSummary.by_model[model].cache_creation_tokens +=
				usage.input_cache_creation_tokens ?? 0;
			this.usageSummary.by_model[model].total_tokens += usage.total_tokens;
		}
	}

	getUsageSummary(): UsageSummary {
		return this.usageSummary;
	}

	getLastUsage(): ChatInvokeUsage | null {
		return this.lastUsage;
	}
}
