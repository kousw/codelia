export type ToolOutputCacheConfig = {
	enabled?: boolean;
	contextBudgetTokens?: number | null;
	totalBudgetTrim?: boolean;
	maxMessageBytes?: number;
	maxLineLength?: number;
};
