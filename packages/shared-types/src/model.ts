import { z } from "zod";

/** Named speed tiers beyond the boolean Fast switch. */
export const ModelSpeedTierSchema = z
	.enum(["ultrafast"])
	.meta({ id: "ModelSpeedTier" });

/** Explicit speed selection; booleans preserve the original fast-mode contract. */
export const ModelFastModeSchema = z
	.union([z.boolean(), ModelSpeedTierSchema])
	.meta({ id: "ModelFastMode" });
export type ModelFastMode = z.infer<typeof ModelFastModeSchema>;

export const isModelFastMode = (value: unknown): value is ModelFastMode =>
	typeof value === "boolean" || value === "ultrafast";

export const MODEL_REASONING_LEVELS = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

export const ModelReasoningLevelSchema = z
	.enum(MODEL_REASONING_LEVELS)
	.meta({ id: "ModelReasoningLevel" });
export type ModelReasoningLevel = z.infer<typeof ModelReasoningLevelSchema>;

export const isModelReasoningLevel = (
	value: string,
): value is ModelReasoningLevel =>
	MODEL_REASONING_LEVELS.some((level) => level === value);
