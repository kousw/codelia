import { ANTHROPIC_MODELS } from "./anthropic";
import { GOOGLE_MODELS } from "./google";
import { MOONSHOT_MODELS } from "./moonshot";
import { OPENAI_MODELS } from "./openai";
import { createModelRegistry } from "./registry";
import { XAI_MODELS } from "./xai";
import { ZAI_MODELS } from "./zai";

export * from "./anthropic";
export * from "./google";
export * from "./moonshot";
export * from "./openai";
export * from "./registry";
export * from "./xai";
export * from "./zai";

export const DEFAULT_MODEL_REGISTRY = createModelRegistry([
	...OPENAI_MODELS,
	...ANTHROPIC_MODELS,
	...GOOGLE_MODELS,
	...MOONSHOT_MODELS,
	...ZAI_MODELS,
	...XAI_MODELS,
]);
