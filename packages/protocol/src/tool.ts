export type ToolCallParams = {
	name: string;
	arguments?: Record<string, unknown>;
};

export type ToolCallResult = {
	ok: boolean;
	result: unknown;
};
