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

const buildHostedSearchToolDefinitions = (
	provider: SupportedProvider,
	options: ResolvedSearchConfig,
): ToolDefinition[] => {
	if (
		options.mode === "local" ||
		!options.native.providers.includes(provider)
	) {
		return [];
	}
	if (provider !== "openai" && provider !== "anthropic") {
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
	const hostedTools = searchConfig
		? buildHostedSearchToolDefinitions(provider, searchConfig)
		: [];
	if (searchConfig?.mode === "native" && hostedTools.length === 0) {
		throw new Error(
			`search.mode=native is enabled, but native search is unavailable for provider '${provider}'.`,
		);
	}
	const useLocalSearchTool =
		searchConfig?.mode === "local" ||
		(searchConfig?.mode === "auto" && hostedTools.length === 0);
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
