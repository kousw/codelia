import type { ModelReasoningLevel } from "@codelia/shared-types";

export type ModelListParams = {
	provider?: string;
	include_details?: boolean;
};

export type ModelListDetails = {
	release_date?: string;
	context_window?: number;
	max_input_tokens?: number;
	max_output_tokens?: number;
	cost_per_1m_input_tokens_usd?: number;
	cost_per_1m_output_tokens_usd?: number;
};

export type ModelListResult = {
	provider: string;
	models: string[];
	current?: string;
	source?: "config" | "session";
	reasoning?: ModelReasoningLevel;
	fast?: boolean;
	details?: Record<string, ModelListDetails>;
};

export type ModelSetParams = {
	name?: string;
	provider?: string;
	reasoning?: ModelReasoningLevel;
	fast?: boolean;
	scope?: "config" | "session";
	reset?: boolean;
};

export type ModelSetResult = {
	provider: string;
	name: string;
	source: "config" | "session";
	reasoning?: ModelReasoningLevel;
	fast?: boolean;
};
