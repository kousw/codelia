import { z } from "zod";

export type BuiltinProviderName =
	| "openai"
	| "anthropic"
	| "openrouter"
	| "google"
	| "deepseek"
	| "moonshot"
	| "zai"
	| "xai";

/** Runtime endpoint names are configured independently of builtin adapters. */
export const ProviderNameSchema = z.string().meta({ id: "ProviderName" });
export type ProviderName = z.infer<typeof ProviderNameSchema>;
