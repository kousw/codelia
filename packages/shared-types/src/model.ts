/** Explicit speed selection; booleans preserve the original fast-mode contract. */
export type ModelFastMode = boolean | "ultrafast";

export const isModelFastMode = (value: unknown): value is ModelFastMode =>
	typeof value === "boolean" || value === "ultrafast";

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
