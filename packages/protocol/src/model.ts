import type { ModelReasoningLevel } from "@codelia/shared-types";

export type ModelListParams = {
	provider?: string;
	include_details?: boolean;
	/** Static built-in catalog, without auth, metadata network or config reads; requires provider. */
	catalog_only?: boolean;
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
	catalog_only?: boolean;
	models: string[];
	current?: string;
	source?: "config" | "session";
	reasoning?: ModelReasoningLevel;
	fast?: boolean;
	details?: Record<string, ModelListDetails>;
};

export type ModelSetParams = {
	/** Compare-and-set guard for session scope; null explicitly means no bound runtime session. */
	expected_session_id?: string | null;
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
