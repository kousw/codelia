import type { ProviderName } from "../llm/base";
import type { ModelRegistry } from "../models/registry";
import { resolveModel } from "../models/registry";
import type { ChatInvokeUsage } from "../types/llm/invoke";

export type ContextLeftInput = {
	usage: ChatInvokeUsage | null;
	modelRegistry: ModelRegistry;
	provider: ProviderName;
	model: string;
};

export const calculateContextLeftPercent = ({
	usage,
	modelRegistry,
	provider,
	model,
}: ContextLeftInput): number | null => {
	if (!usage) {
		return null;
	}
	const usageModelSpec = usage.model
		? resolveModelWithQualifiedFallback(modelRegistry, provider, usage.model)
		: undefined;
	const modelSpec =
		usageModelSpec ??
		resolveModelWithQualifiedFallback(modelRegistry, provider, model);
	const contextLimit =
		modelSpec?.maxInputTokens ?? modelSpec?.contextWindow ?? null;
	if (!contextLimit || contextLimit <= 0) {
		return null;
	}
	const used = usage.total_tokens;
	if (!Number.isFinite(used) || used <= 0) {
		return 100;
	}
	const leftRatio = 1 - used / contextLimit;
	const percent = Math.round(leftRatio * 100);
	return Math.max(0, Math.min(100, percent));
};

const resolveModelWithQualifiedFallback = (
	modelRegistry: ModelRegistry,
	provider: ProviderName,
	modelId: string,
) => {
	const direct = resolveModel(modelRegistry, modelId, provider);
	if (direct) return direct;
	const qualified = parseQualifiedModelId(modelId);
	if (!qualified) return resolveModel(modelRegistry, modelId);
	return (
		resolveModel(modelRegistry, qualified.modelId, qualified.provider) ??
		resolveModel(
			modelRegistry,
			`${qualified.provider}/${qualified.modelId}`,
			qualified.provider,
		)
	);
};

const parseQualifiedModelId = (
	modelId: string,
): { provider: ProviderName; modelId: string } | null => {
	const sep = modelId.indexOf("/");
	if (sep <= 0 || sep >= modelId.length - 1) {
		return null;
	}
	const providerRaw = modelId.slice(0, sep);
	const rest = modelId.slice(sep + 1);
	if (!rest) {
		return null;
	}
	if (
		providerRaw !== "openai" &&
		providerRaw !== "anthropic" &&
		providerRaw !== "openrouter" &&
		providerRaw !== "google" &&
		providerRaw !== "moonshot" &&
		providerRaw !== "zai"
	) {
		return null;
	}
	return { provider: providerRaw, modelId: rest };
};
