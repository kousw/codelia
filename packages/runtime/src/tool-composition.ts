import type { Tool, ToolDefinition } from "@codelia/core";
import type { SupportedProvider } from "./auth/resolver";
import type { ResolvedSearchConfig } from "./config";
import type { ToolProvider } from "./environment";
import { createSearchTool } from "./tools/search";

export type RuntimeToolCompositionInput = {
	provider: SupportedProvider;
	baseTools: Tool[];
	mcpTools: Tool[];
	hostTools: Tool[];
	searchConfig?: ResolvedSearchConfig;
};

export type RuntimeToolCompositionResult = {
	tools: Tool[];
	toolDefinitions: ToolDefinition[];
	hostedTools: ToolDefinition[];
	hostToolNames: Set<string>;
	editTool?: Tool;
	applyPatchTool?: Tool;
};

const buildHostedWebSearchToolDefinitions = (
	provider: SupportedProvider,
	options: ResolvedSearchConfig,
): ToolDefinition[] => {
	if (
		options.mode === "local" ||
		!options.native.providers.includes(provider)
	) {
		return [];
	}
	if (provider !== "openai" && provider !== "anthropic" && provider !== "xai") {
		return [];
	}
	return [
		{
			type: "hosted_search",
			name: "web_search",
			provider,
			...(options.native.searchContextSize
				? { search_context_size: options.native.searchContextSize }
				: {}),
			...(options.native.allowedDomains
				? { allowed_domains: options.native.allowedDomains }
				: {}),
			...(options.native.userLocation
				? { user_location: options.native.userLocation }
				: {}),
		},
	];
};

const buildHostedXSearchToolDefinitions = (
	provider: SupportedProvider,
	options: ResolvedSearchConfig,
): ToolDefinition[] => {
	const config = options.xai.xSearch;
	if (provider !== "xai" || !config.enabled) {
		return [];
	}
	return [
		{
			type: "hosted_search",
			search_kind: "x",
			name: "x_search",
			provider: "xai",
			...(config.allowedXHandles
				? { allowed_x_handles: config.allowedXHandles }
				: {}),
			...(config.excludedXHandles
				? { excluded_x_handles: config.excludedXHandles }
				: {}),
			...(config.fromDate ? { from_date: config.fromDate } : {}),
			...(config.toDate ? { to_date: config.toDate } : {}),
			...(typeof config.enableImageUnderstanding === "boolean"
				? { enable_image_understanding: config.enableImageUnderstanding }
				: {}),
			...(typeof config.enableVideoUnderstanding === "boolean"
				? { enable_video_understanding: config.enableVideoUnderstanding }
				: {}),
		},
	];
};

export const loadRuntimeHostTools = async (
	providers: ToolProvider[],
): Promise<Tool[]> => {
	const groups = await Promise.all(
		providers.map((provider) => Promise.resolve(provider.getTools())),
	);
	return groups.flat();
};

export const composeRuntimeTools = async ({
	provider,
	baseTools,
	mcpTools,
	hostTools,
	searchConfig,
}: RuntimeToolCompositionInput): Promise<RuntimeToolCompositionResult> => {
	const hostedWebSearchTools = searchConfig
		? buildHostedWebSearchToolDefinitions(provider, searchConfig)
		: [];
	const hostedXSearchTools = searchConfig
		? buildHostedXSearchToolDefinitions(provider, searchConfig)
		: [];
	const hostedTools = [...hostedWebSearchTools, ...hostedXSearchTools];
	if (searchConfig?.mode === "native" && hostedWebSearchTools.length === 0) {
		throw new Error(
			`search.mode=native is enabled, but native search is unavailable for provider '${provider}'.`,
		);
	}
	const useLocalSearchTool =
		searchConfig?.mode === "local" ||
		(searchConfig?.mode === "auto" && hostedWebSearchTools.length === 0);
	const localSearchTools =
		useLocalSearchTool && searchConfig
			? [
					createSearchTool({
						defaultBackend: searchConfig.local.backend,
						braveApiKeyEnv: searchConfig.local.braveApiKeyEnv,
					}),
				]
			: [];
	const tools = [...baseTools, ...localSearchTools, ...mcpTools, ...hostTools];

	return {
		tools,
		toolDefinitions: [...tools.map((tool) => tool.definition), ...hostedTools],
		hostedTools,
		hostToolNames: new Set(hostTools.map((tool) => tool.name)),
		editTool: baseTools.find((tool) => tool.definition.name === "edit"),
		applyPatchTool: baseTools.find(
			(tool) => tool.definition.name === "apply_patch",
		),
	};
};
