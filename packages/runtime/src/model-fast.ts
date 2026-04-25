import type { BaseChatModel } from "@codelia/core";
import { DEFAULT_MODEL_REGISTRY, supportsFastMode } from "@codelia/core";

type FastModeResolution =
	| { enabled: false }
	| { enabled: true; provider: "openai"; serviceTier: "priority" }
	| { enabled: true; provider: "anthropic"; fastMode: true };

export const resolveFastMode = (params: {
	provider: BaseChatModel["provider"];
	model: string;
	requested?: boolean;
}): FastModeResolution => {
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
