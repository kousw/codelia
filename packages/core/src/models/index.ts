import { ANTHROPIC_MODELS } from "./anthropic";
import { GOOGLE_MODELS } from "./google";
import { OPENAI_MODELS } from "./openai";
import { createModelRegistry } from "./registry";
import { ZAI_MODELS } from "./zai";

export * from "./anthropic";
export * from "./google";
export * from "./openai";
export * from "./registry";
export * from "./zai";

export const DEFAULT_MODEL_REGISTRY = createModelRegistry([
	...OPENAI_MODELS,
	...ANTHROPIC_MODELS,
	...GOOGLE_MODELS,
	...ZAI_MODELS,
]);
