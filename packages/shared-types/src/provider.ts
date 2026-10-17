export type BuiltinProviderName =
	| "openai"
	| "anthropic"
	| "openrouter"
	| "google"
	| "moonshot"
	| "zai"
	| "xai";

/** Runtime endpoint names are configured independently of builtin adapters. */
export type ProviderName = string;
