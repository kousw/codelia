export const MODEL_REASONING_LEVELS = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

export type ModelReasoningLevel = (typeof MODEL_REASONING_LEVELS)[number];

export const isModelReasoningLevel = (
	value: string,
): value is ModelReasoningLevel =>
	MODEL_REASONING_LEVELS.some((level) => level === value);
