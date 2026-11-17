import type { BaseChatModel } from "@codelia/core";
import {
	DEFAULT_MODEL_REGISTRY,
	resolveProviderModelId,
	supportsFastMode,
} from "@codelia/core";
import type { ModelFastMode } from "@codelia/shared-types";

type FastModeResolution =
	| { enabled: false }
	| { enabled: true; provider: "openai"; serviceTier: "priority" | "ultrafast" }
	| { enabled: true; provider: "anthropic"; fastMode: true };

const OPENAI_ULTRAFAST_MODELS = [
	"gpt-6.2-astra",
	"gpt-6.2-sol",
	"gpt-6-astra",
	"gpt-6.1-sol",
];

export const resolveFastMode = (params: {
	provider: BaseChatModel["provider"];
	model: string;
	requested?: ModelFastMode;
}): FastModeResolution => {
	if (params.requested === "ultrafast") {
		const model =
			resolveProviderModelId(
				DEFAULT_MODEL_REGISTRY,
				params.model,
				params.provider,
			) ?? params.model;
		if (
			params.provider !== "openai" ||
			!OPENAI_ULTRAFAST_MODELS.includes(model)
		) {
			throw new Error(
				`Ultrafast requires OpenAI with a supported model (${OPENAI_ULTRAFAST_MODELS.join(", ")}). Select /fast off before using another model.`,
			);
		}
		return { enabled: true, provider: "openai", serviceTier: "ultrafast" };
	}
	if (params.requested !== true) {
		return { enabled: false };
	}
	if (
		!supportsFastMode(DEFAULT_MODEL_REGISTRY, params.model, params.provider)
	) {
		return { enabled: false };
	}
	if (params.provider === "openai") {
		return { enabled: true, provider: "openai", serviceTier: "priority" };
	}
	if (params.provider === "anthropic") {
		return { enabled: true, provider: "anthropic", fastMode: true };
	}
	return { enabled: false };
};

export const effectiveFastMode = (
	params: Parameters<typeof resolveFastMode>[0],
): ModelFastMode =>
	resolveFastMode(params).enabled ? (params.requested ?? false) : false;
