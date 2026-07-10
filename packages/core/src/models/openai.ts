import type { ModelSpec } from "./registry";

export const OPENAI_DEFAULT_MODEL = "gpt-5.6";
export const OPENAI_DEFAULT_REASONING_EFFORT = "medium";
const GPT_5_6_CONTEXT_WINDOW = 1_050_000;
const GPT_5_6_CAPPED_INPUT_TOKENS = 270_000;
const GPT_5_6_FULL_INPUT_TOKENS = 922_000;
const GPT_5_6_MAX_OUTPUT_TOKENS = 128_000;
const GPT_5_4_CAPPED_INPUT_TOKENS = 272_000;

const GPT_5_6_PROVIDER_MODELS = [
	"gpt-5.6",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
] as const;

const buildGpt56Models = (providerModelId: string): ModelSpec[] => [
	{
		id: providerModelId,
		provider: "openai",
		contextWindow: GPT_5_6_CONTEXT_WINDOW,
		maxInputTokens: GPT_5_6_CAPPED_INPUT_TOKENS,
		maxOutputTokens: GPT_5_6_MAX_OUTPUT_TOKENS,
		supportsFast: true,
	},
	{
		id: `${providerModelId}-1M`,
		provider: "openai",
		providerModelId,
		aliases: [`${providerModelId}-1m`, `${providerModelId}-full`],
		contextWindow: GPT_5_6_CONTEXT_WINDOW,
		maxInputTokens: GPT_5_6_FULL_INPUT_TOKENS,
		maxOutputTokens: GPT_5_6_MAX_OUTPUT_TOKENS,
	},
];

export const OPENAI_MODELS: ModelSpec[] = [
	{
		id: OPENAI_DEFAULT_MODEL,
		provider: "openai",
		aliases: ["default"],
	},
	...GPT_5_6_PROVIDER_MODELS.flatMap(buildGpt56Models),
	{
		id: "gpt-5.5",
		provider: "openai",
		contextWindow: 1_050_000,
		maxInputTokens: 270_000,
		maxOutputTokens: 130_000,
		supportsFast: true,
	},
	{
		id: "gpt-5.5-1M",
		provider: "openai",
		providerModelId: "gpt-5.5",
		aliases: ["gpt-5.5-1m", "gpt-5.5-full"],
		contextWindow: 1_050_000,
		maxInputTokens: 920_000,
		maxOutputTokens: 130_000,
	},
	{
		id: "gpt-5.5-pro",
		provider: "openai",
	},
	{
		id: "gpt-5.4",
		provider: "openai",
		contextWindow: 1050000,
		maxInputTokens: GPT_5_4_CAPPED_INPUT_TOKENS,
		maxOutputTokens: 128000,
		supportsFast: true,
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
		id: "gpt-5.4-pro",
		provider: "openai",
		contextWindow: 1050000,
		maxInputTokens: 922000,
		maxOutputTokens: 128000,
	},
	{
		id: "gpt-5.4-pro-2026-03-05",
		provider: "openai",
		contextWindow: 1050000,
		maxInputTokens: 922000,
		maxOutputTokens: 128000,
	},
	{
		id: "gpt-5.4-mini",
		provider: "openai",
		contextWindow: 400000,
		maxInputTokens: 272000,
		maxOutputTokens: 128000,
		supportsFast: true,
	},
	{
		id: "gpt-5.4-mini-2026-03-17",
		provider: "openai",
		contextWindow: 400000,
		maxInputTokens: 272000,
		maxOutputTokens: 128000,
		supportsFast: true,
	},
	{
		id: "gpt-5.4-nano",
		provider: "openai",
		contextWindow: 400000,
		maxInputTokens: 272000,
		maxOutputTokens: 128000,
	},
	{
		id: "gpt-5.4-nano-2026-03-17",
		provider: "openai",
		contextWindow: 400000,
		maxInputTokens: 272000,
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
		supportsFast: true,
	},
	{
		id: "gpt-5.2",
		provider: "openai",
		supportsFast: true,
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
		supportsFast: true,
	},
	{
		id: "gpt-5.1-2025-11-13",
		provider: "openai",
		supportsFast: true,
	},
	{
		id: "gpt-5",
		provider: "openai",
		supportsFast: true,
	},
	{
		id: "gpt-5-mini",
		provider: "openai",
		supportsFast: true,
	},
	{
		id: "gpt-5-mini-2025-08-07",
		provider: "openai",
		supportsFast: true,
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
		supportsFast: true,
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
		supportsFast: true,
	},
	{
		id: "gpt-5-codex-mini",
		provider: "openai",
	},
];
