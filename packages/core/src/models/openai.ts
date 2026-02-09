import type { ModelSpec } from "./registry";

export const OPENAI_DEFAULT_MODEL = "gpt-5.2-codex";
export const OPENAI_DEFAULT_REASONING_EFFORT = "medium";

export const OPENAI_MODELS: ModelSpec[] = [
	{
		id: OPENAI_DEFAULT_MODEL,
		provider: "openai",
		aliases: ["default"],
	},
	{
		id: "gpt-5.2",
		provider: "openai",
	},
	{
		id: "gpt-5.3-codex",
		provider: "openai",
	},
	{
		id: "gpt-5.2-2025-12-11",
		provider: "openai",
	},
	{
		id: "gpt-5.2-pro",
		provider: "openai",
	},
	{
		id: "gpt-5.2-pro-2025-12-11",
		provider: "openai",
	},
	{
		id: "gpt-5.1",
		provider: "openai",
	},
	{
		id: "gpt-5.1-2025-11-13",
		provider: "openai",
	},
	{
		id: "gpt-5",
		provider: "openai",
	},
	{
		id: "gpt-5-mini",
		provider: "openai",
	},
	{
		id: "gpt-5-mini-2025-08-07",
		provider: "openai",
	},
	{
		id: "gpt-5-nano",
		provider: "openai",
	},
	{
		id: "gpt-5-nano-2025-08-07",
		provider: "openai",
	},
	{
		id: "gpt-5.1-codex",
		provider: "openai",
	},
	{
		id: "gpt-5.1-codex-max",
		provider: "openai",
	},
	{
		id: "gpt-5.1-codex-mini",
		provider: "openai",
	},
	{
		id: "gpt-5-codex",
		provider: "openai",
	},
	{
		id: "gpt-5-codex-mini",
		provider: "openai",
	},
];
