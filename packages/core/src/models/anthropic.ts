import type { ModelSpec } from "./registry";

export const ANTHROPIC_DEFAULT_MODEL = "claude-sonnet-4-5";

export const ANTHROPIC_MODELS: ModelSpec[] = [
	{
		id: ANTHROPIC_DEFAULT_MODEL,
		provider: "anthropic",
		aliases: ["default"],
	},
	{
		id: "claude-opus-4-6",
		provider: "anthropic",
	},
	{
		id: "claude-opus-4-5",
		provider: "anthropic",
	},
	{
		id: "claude-opus-4-5-20251201",
		provider: "anthropic",
	},
	{
		id: "claude-sonnet-4-5-20250929",
		provider: "anthropic",
	},
	{
		id: "claude-haiku-4-5",
		provider: "anthropic",
	},
	{
		id: "claude-haiku-4-5-20250929",
		provider: "anthropic",
	},
];
