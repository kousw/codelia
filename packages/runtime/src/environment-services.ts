import type { PermissionRule, PermissionsConfig } from "@codelia/config";
import type { ModelReasoningLevel } from "@codelia/shared-types";
import type { SupportedProvider } from "./auth/resolver";
import { AuthResolver } from "./auth/resolver";
import type { ProviderAuth } from "./auth/store";
import {
	appendPermissionAllowRules,
	loadSystemPrompt,
	type ResolvedExecutionEnvironmentConfig,
	type ResolvedModelConfig,
	type ResolvedSearchConfig,
	type ResolvedSkillsConfig,
	resolveExecutionEnvironmentConfig,
	resolveModelConfig,
	resolvePermissionsConfig,
	resolveSearchConfig,
	resolveSkillsConfig,
	resolveTuiConfig,
	updateModel,
	updateTuiTheme,
	type WriteTarget,
} from "./config";
import type { RuntimeState } from "./runtime-state";

const requireConfigProviderMethod = <TMethod extends string>(
	method: TMethod,
): Error => new Error(`host config provider does not implement ${method}`);

export const resolveEnvironmentModelConfig = async (
	state: RuntimeState,
	workingDir?: string,
): Promise<ResolvedModelConfig> => {
	if (state.effectiveEnvironment.config.source === "host") {
		const provider = state.effectiveEnvironment.adapters.configProvider;
		if (!provider?.resolveModelConfig) {
			throw requireConfigProviderMethod("resolveModelConfig");
		}
		return provider.resolveModelConfig(workingDir);
	}
	if (state.effectiveEnvironment.config.source === "disabled") {
		return {};
	}
	return resolveModelConfig(workingDir);
};

export const resolveEnvironmentPermissionsConfig = async (
	state: RuntimeState,
	workingDir?: string,
): Promise<PermissionsConfig | undefined> => {
	if (state.effectiveEnvironment.config.source === "host") {
		const provider = state.effectiveEnvironment.adapters.configProvider;
		if (!provider?.resolvePermissionsConfig) {
			return undefined;
		}
		return provider.resolvePermissionsConfig(workingDir);
	}
	if (state.effectiveEnvironment.config.source === "disabled") {
		return undefined;
	}
	return resolvePermissionsConfig(workingDir);
};

export const resolveEnvironmentSearchConfig = async (
	state: RuntimeState,
	workingDir?: string,
): Promise<ResolvedSearchConfig> => {
	if (state.effectiveEnvironment.config.source === "host") {
		const provider = state.effectiveEnvironment.adapters.configProvider;
		if (!provider?.resolveSearchConfig) {
			throw requireConfigProviderMethod("resolveSearchConfig");
		}
		return provider.resolveSearchConfig(workingDir);
	}
	return resolveSearchConfig(workingDir);
};

export const resolveEnvironmentSkillsConfig = async (
	state: RuntimeState,
	workingDir?: string,
): Promise<ResolvedSkillsConfig> => {
	if (state.effectiveEnvironment.config.source === "host") {
		const provider = state.effectiveEnvironment.adapters.configProvider;
		if (!provider?.resolveSkillsConfig) {
			throw requireConfigProviderMethod("resolveSkillsConfig");
		}
		return provider.resolveSkillsConfig(workingDir);
	}
	return resolveSkillsConfig(workingDir);
};

export const resolveEnvironmentExecutionEnvironmentConfig = async (
	state: RuntimeState,
	workingDir?: string,
): Promise<ResolvedExecutionEnvironmentConfig> => {
	if (state.effectiveEnvironment.config.source === "host") {
		const provider = state.effectiveEnvironment.adapters.configProvider;
		if (!provider?.resolveExecutionEnvironmentConfig) {
			throw requireConfigProviderMethod("resolveExecutionEnvironmentConfig");
		}
		return provider.resolveExecutionEnvironmentConfig(workingDir);
	}
	return resolveExecutionEnvironmentConfig(workingDir);
};

export const resolveEnvironmentTuiConfig = async (
	state: RuntimeState,
	workingDir?: string,
): Promise<{ theme?: string }> => {
	if (state.effectiveEnvironment.config.source === "host") {
		const provider = state.effectiveEnvironment.adapters.configProvider;
		if (!provider?.resolveTuiConfig) {
			return {};
		}
		return provider.resolveTuiConfig(workingDir);
	}
	if (state.effectiveEnvironment.config.source === "disabled") {
		return {};
	}
	return resolveTuiConfig(workingDir);
};

export const updateEnvironmentModel = async (
	state: RuntimeState,
	workingDir: string | undefined,
	model: {
		provider: string;
		name: string;
		reasoning?: ModelReasoningLevel;
		fast?: boolean;
	},
): Promise<WriteTarget> => {
	if (state.effectiveEnvironment.config.source === "host") {
		const provider = state.effectiveEnvironment.adapters.configProvider;
		if (!provider?.updateModel) {
			throw requireConfigProviderMethod("updateModel");
		}
		return provider.updateModel(workingDir, model);
	}
	if (state.effectiveEnvironment.config.source === "disabled") {
		throw new Error("config writes are disabled");
	}
	return updateModel(workingDir ?? process.cwd(), model);
};

export const updateEnvironmentTuiTheme = async (
	state: RuntimeState,
	workingDir: string | undefined,
	theme: string,
): Promise<WriteTarget> => {
	if (state.effectiveEnvironment.config.source === "host") {
		const provider = state.effectiveEnvironment.adapters.configProvider;
		if (!provider?.updateTuiTheme) {
			throw requireConfigProviderMethod("updateTuiTheme");
		}
		return provider.updateTuiTheme(workingDir, theme);
	}
	if (state.effectiveEnvironment.config.source === "disabled") {
		throw new Error("config writes are disabled");
	}
	return updateTuiTheme(workingDir ?? process.cwd(), theme);
};

export const appendEnvironmentPermissionAllowRules = async (
	state: RuntimeState,
	workingDir: string | undefined,
	rules: PermissionRule[],
): Promise<void> => {
	if (!rules.length) return;
	if (state.effectiveEnvironment.config.source === "host") {
		const provider = state.effectiveEnvironment.adapters.configProvider;
		if (!provider?.appendPermissionAllowRules) {
			throw requireConfigProviderMethod("appendPermissionAllowRules");
		}
		await provider.appendPermissionAllowRules(workingDir, rules);
		return;
	}
	if (state.effectiveEnvironment.config.source === "disabled") {
		throw new Error("config writes are disabled");
	}
	await appendPermissionAllowRules(workingDir ?? process.cwd(), rules);
};

export const loadEnvironmentSystemPrompt = async (
	state: RuntimeState,
	workingDir?: string,
): Promise<string> => {
	if (state.effectiveEnvironment.context.systemPrompt === "host") {
		const provider = state.effectiveEnvironment.adapters.systemPromptProvider;
		if (!provider) {
			throw new Error("host system prompt provider is required");
		}
		return provider.loadSystemPrompt(workingDir);
	}
	return loadSystemPrompt(workingDir ?? process.cwd());
};

export const createEnvironmentAuthResolver = async (
	state: RuntimeState,
	log: (message: string) => void,
): Promise<{
	hasAnyAvailableAuth: () => boolean | Promise<boolean>;
	resolveProvider: (preferred?: string | null) => Promise<SupportedProvider>;
	resolveProviderAuth: (provider: SupportedProvider) => Promise<ProviderAuth>;
	getOpenAiAccessToken?: () => Promise<{ token: string; accountId?: string }>;
}> => {
	if (state.effectiveEnvironment.auth.model === "host") {
		const provider = state.effectiveEnvironment.adapters.credentialProvider;
		if (!provider) {
			throw new Error("host credential provider is required");
		}
		return {
			hasAnyAvailableAuth: provider.hasAnyAvailableAuth ?? (() => true),
			resolveProvider: provider.resolveProvider,
			resolveProviderAuth: provider.resolveProviderAuth,
			getOpenAiAccessToken: provider.getOpenAiAccessToken,
		};
	}
	return AuthResolver.create(state, log);
};
