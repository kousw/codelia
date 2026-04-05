import type { ModelSpec } from "./registry";

export const OPENAI_DEFAULT_MODEL = "gpt-5.3-codex";
export const OPENAI_DEFAULT_REASONING_EFFORT = "medium";
const GPT_5_4_CAPPED_INPUT_TOKENS = 272_000;

export const OPENAI_MODELS: ModelSpec[] = [
	{
		id: OPENAI_DEFAULT_MODEL,
		provider: "openai",
		aliases: ["default"],
	},
	{
		id: "gpt-5.4",
		provider: "openai",
		contextWindow: 1050000,
		maxInputTokens: GPT_5_4_CAPPED_INPUT_TOKENS,
		maxOutputTokens: 128000,
	},
	{
		id: "gpt-5.4-1M",
		provider: "openai",
		providerModelId: "gpt-5.4",
		aliases: ["gpt-5.4-1m", "gpt-5.4-full"],
		contextWindow: 1050000,
		maxInputTokens: 942000,
		maxOutputTokens: 128000,
	},
	{
		id: "gpt-5.3-codex",
		provider: "openai",
	},
	{
		id: "gpt-5.3-codex-spark",
		provider: "openai",
		contextWindow: 128000,
	},
	{
		id: "gpt-5.2-2025-12-11",
		provider: "openai",
	},
	{
		id: "gpt-5.2",
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
