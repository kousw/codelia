export type ContextUsageCategory =
	| "system"
	| "tools"
	| "messages"
	| "tool_results"
	| "images";

export type ContextUsageBreakdownEntry = {
	category: ContextUsageCategory;
	/** Estimated tokens of the current history in this category. */
	tokens: number;
	/** Number of items (images only). */
	count?: number;
};

/** Context window usage of one agent; produced by core, sent by runtime. */
export type ContextUsage = {
	/** Null only when no agent has been built yet. */
	provider: string | null;
	model: string | null;
	/** Model input limit (`maxInputTokens ?? contextWindow`); null when unknown. */
	limit_tokens: number | null;
	/** Last provider-reported `total_tokens` (same basis as `left_percent`). */
	used_tokens: number | null;
	/** Last provider-reported `input_tokens`. */
	input_tokens: number | null;
	left_percent: number | null;
	/** `provider`: used/input come from the last model call; `none`: no call yet. */
	basis: "provider" | "none";
	/**
	 * Size estimate of the current history and tool definitions by category
	 * (serialized bytes / 3; images via the model's image-token estimate). Not
	 * normalized to `used_tokens`, which stays provider-reported only.
	 */
	breakdown: ContextUsageBreakdownEntry[];
};
