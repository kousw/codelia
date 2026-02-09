import type { ToolOutputRef } from "../../types/llm";

export type ToolOutputCacheRecord = {
	tool_call_id: string;
	tool_name: string;
	content: string;
	is_error?: boolean;
};

export type ToolOutputCacheReadOptions = {
	offset?: number;
	limit?: number;
};

export type ToolOutputCacheSearchOptions = {
	pattern: string;
	regex?: boolean;
	before?: number;
	after?: number;
	max_matches?: number;
};

export type ToolOutputCacheStore = {
	save: (
		record: ToolOutputCacheRecord,
	) => Promise<ToolOutputRef> | ToolOutputRef;
	read?: (
		refId: string,
		options?: ToolOutputCacheReadOptions,
	) => Promise<string> | string;
	grep?: (
		refId: string,
		options: ToolOutputCacheSearchOptions,
	) => Promise<string> | string;
};
