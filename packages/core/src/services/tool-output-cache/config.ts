export type ToolOutputCacheConfig = {
	enabled?: boolean;
	contextBudgetTokens?: number | null;
	maxMessageBytes?: number;
	maxLineLength?: number;
};
