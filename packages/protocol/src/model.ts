export type ModelListParams = {
	provider?: string;
	include_details?: boolean;
};

export type ModelListDetails = {
	context_window?: number;
	max_input_tokens?: number;
	max_output_tokens?: number;
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
