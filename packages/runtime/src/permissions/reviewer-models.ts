import {
	anthropicApprovalReviewEndpoint,
	anthropicApprovalReviewModel,
	createAnthropicApprovalReviewer,
} from "./anthropic-reviewer";
import {
	createDeepSeekApprovalReviewer,
	deepSeekApprovalReviewEndpoint,
	deepSeekApprovalReviewModel,
} from "./deepseek-reviewer";
import type { ReviewAdapter } from "./dispatch";
import {
	createMoonshotApprovalReviewer,
	createOpenRouterApprovalReviewer,
	createXaiApprovalReviewer,
	moonshotApprovalReviewEndpoint,
	moonshotApprovalReviewModel,
	openRouterApprovalReviewEndpoint,
	openRouterApprovalReviewModel,
	openRouterApprovalReviewUpstream,
	xaiApprovalReviewEndpoint,
	xaiApprovalReviewModel,
} from "./external-reviewers";
import {
	createGoogleApprovalReviewer,
	googleApprovalReviewEndpoint,
	googleApprovalReviewModel,
} from "./google-reviewer";
import {
	createOpenAiApprovalReviewer,
	type PublicApprovalReviewerOptions,
} from "./public-reviewer";
import {
	createZaiApprovalReviewer,
	zaiApprovalReviewEndpoint,
	zaiApprovalReviewModel,
} from "./zai-reviewer";

export type RegisteredReviewModel = Readonly<{
	provider: string;
	providerName: string;
	model: string;
	endpoint: string;
	billing: string;
	follow?: true;
	experimental?: true;
	dataHandling?: readonly string[];
	revision: number;
	createAdapter: (
		options: Omit<PublicApprovalReviewerOptions, "effort" | "fetcher">,
	) => ReviewAdapter;
}>;

const lunaTarget = Object.freeze({
	endpoint: "https://api.openai.com/v1/responses",
	model: "gpt-6-luna",
	effort: "low" as const,
});

const openAiLuna: RegisteredReviewModel = Object.freeze({
	provider: "openai",
	providerName: "OpenAI",
	model: lunaTarget.model,
	endpoint: lunaTarget.endpoint,
	billing: "Existing OpenAI API key, Standard usage and account data terms.",
	follow: true,
	experimental: true,
	revision: 2,
	dataHandling: Object.freeze([
		"Conversation storage is disabled for this request.",
	]),
	createAdapter: (
		options: Parameters<RegisteredReviewModel["createAdapter"]>[0],
	) => createOpenAiApprovalReviewer(lunaTarget, options),
});

const experimental = (
	entry: Omit<RegisteredReviewModel, "follow" | "experimental" | "revision">,
): RegisteredReviewModel =>
	Object.freeze({
		...entry,
		dataHandling: Object.freeze(entry.dataHandling ?? []),
		follow: true,
		experimental: true,
		revision: 2,
	});

export const localReviewModels = Object.freeze([
	openAiLuna,
	experimental({
		provider: "google",
		providerName: "Google",
		model: googleApprovalReviewModel,
		endpoint: googleApprovalReviewEndpoint,
		billing:
			"Existing Google API key. The project's paid or unpaid status is unverified.",
		dataHandling: [
			"Under unpaid terms, Google may use content for improvement and human review, subject to region.",
			"Paid terms exclude product improvement and allow limited safety and legal logging.",
			"Interaction storage is disabled.",
		],
		createAdapter: createGoogleApprovalReviewer,
	}),
	experimental({
		provider: "anthropic",
		providerName: "Anthropic",
		model: anthropicApprovalReviewModel,
		endpoint: anthropicApprovalReviewEndpoint,
		billing: "Existing Anthropic workspace API key, Standard metered usage.",
		dataHandling: [
			"Anthropic commercial API data is excluded from training by default.",
			"Account retention terms apply. A static output schema can be cached for up to 24 hours.",
		],
		createAdapter: createAnthropicApprovalReviewer,
	}),
	experimental({
		provider: "deepseek",
		providerName: "DeepSeek",
		model: deepSeekApprovalReviewModel,
		endpoint: deepSeekApprovalReviewEndpoint,
		billing: "Existing DeepSeek API key, metered usage.",
		dataHandling: [
			"deepseek-flash is a rolling alias. The serving model may change.",
			"Responses are stateless. Automatic disk caching usually persists for hours to days.",
			"Applicable personal data may be processed in China. Review your data terms.",
			"Public API terms limit reliance on output. Confirm your use is allowed.",
		],
		createAdapter: createDeepSeekApprovalReviewer,
	}),
	experimental({
		provider: "xai",
		providerName: "xAI",
		model: xaiApprovalReviewModel,
		endpoint: xaiApprovalReviewEndpoint,
		billing: "Existing xAI API key, metered usage including reasoning.",
		dataHandling: [
			"Conversation storage is disabled. Standard API audit retention is 30 days.",
			"Training requires permission. Team zero-data retention depends on account settings.",
		],
		createAdapter: createXaiApprovalReviewer,
	}),
	experimental({
		provider: "moonshot",
		providerName: "Moonshot",
		model: moonshotApprovalReviewModel,
		endpoint: moonshotApprovalReviewEndpoint,
		billing: "Existing Moonshot API key, Standard Kimi API usage.",
		dataHandling: [
			"Automatic caching applies. Under public terms, inputs may be retained and used for improvement.",
			"Moonshot's public policy describes storage in Singapore. Account terms may differ.",
		],
		createAdapter: createMoonshotApprovalReviewer,
	}),
	experimental({
		provider: "zai",
		providerName: "Z.ai",
		model: zaiApprovalReviewModel,
		endpoint: zaiApprovalReviewEndpoint,
		billing: "Existing Z.ai API key, public API metered usage.",
		dataHandling: [
			"Z.ai's public API terms restrict decision-making. Use only if your agreement permits it.",
			"API data handling and retention follow your Z.ai agreement.",
		],
		createAdapter: createZaiApprovalReviewer,
	}),
	experimental({
		provider: "openrouter",
		providerName: "OpenRouter",
		model: openRouterApprovalReviewModel,
		endpoint: openRouterApprovalReviewEndpoint,
		billing:
			"Existing OpenRouter API key. OpenRouter account routing and billing apply. Account-side BYOK may affect billing.",
		dataHandling: [
			`OpenRouter sends to the fixed upstream ${openRouterApprovalReviewUpstream}. Other upstreams and fallback are disabled. Only a managed, non-BYOK response is accepted.`,
			"OpenRouter and upstream data terms apply. Account settings can affect logging and safety retention.",
		],
		createAdapter: createOpenRouterApprovalReviewer,
	}),
]);

export const selectFollowingReviewModel = (
	registry: readonly RegisteredReviewModel[],
	provider: string,
): RegisteredReviewModel | undefined => {
	const candidates = registry.filter(
		(entry) => entry.provider === provider && entry.follow,
	);
	return candidates.length === 1 ? candidates[0] : undefined;
};

export const reviewModelLabel = (reviewer: RegisteredReviewModel): string =>
	`${reviewer.providerName} / ${reviewer.model}${reviewer.experimental ? " (Experimental / decision quality untested)" : ""}`;

export const reviewModelDetails = (
	reviewer: RegisteredReviewModel,
): string[] => [
	`Destination ${reviewer.endpoint}`,
	reviewer.billing,
	...(reviewer.dataHandling ?? []),
];

export const selectLocalReviewModel = (
	registry: readonly RegisteredReviewModel[],
	provider?: string,
	model?: string,
): RegisteredReviewModel | undefined => {
	if (provider === undefined)
		return model === undefined
			? registry.find(
					(entry) =>
						entry.provider === openAiLuna.provider &&
						entry.model === openAiLuna.model,
				)
			: undefined;
	const candidates = registry.filter((entry) => entry.provider === provider);
	return model === undefined
		? candidates.length === 1
			? candidates[0]
			: undefined
		: candidates.find((entry) => entry.model === model);
};

/** Standard public OpenAI reviewer for SDK hosts using an existing API key. */
export const createPublicApprovalReviewer = (
	options: PublicApprovalReviewerOptions,
): ReviewAdapter => createOpenAiApprovalReviewer(lunaTarget, options);
