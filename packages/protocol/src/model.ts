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
	details?: Record<string, ModelListDetails>;
};

export type ModelSetParams = {
	name: string;
	provider?: string;
};

export type ModelSetResult = {
	provider: string;
	name: string;
};
