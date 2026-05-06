import { type ResolvedModelConfig, resolveModelConfig } from "./config";
import type {
	RuntimeModelOverride,
	RuntimeModelSource,
	RuntimeState,
} from "./runtime-state";

type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | undefined;

export type EffectiveModelConfig = ResolvedModelConfig & {
	source: RuntimeModelSource;
};

const mergeModelOverride = (
	config: ResolvedModelConfig,
	override: RuntimeModelOverride | null,
): ResolvedModelConfig => {
	if (!override) return config;
	return {
		...config,
		provider: override.provider ?? config.provider,
		name: override.name ?? config.name,
		reasoning: override.reasoning ?? config.reasoning,
		fast: override.fast ?? config.fast,
	};
};

export const resolveEffectiveModelConfig = async (
	state: RuntimeState,
	workingDir?: string,
): Promise<EffectiveModelConfig> => {
	const config = await resolveModelConfig(workingDir);
	const source = state.sessionModelOverride ? "session" : "config";
	return {
		...mergeModelOverride(config, state.sessionModelOverride),
		source,
	};
};

export const setSessionModelOverride = (
	state: RuntimeState,
	baseConfig: ResolvedModelConfig,
	next: {
		provider: string;
		name: string;
		reasoning?: ReasoningEffort;
		fast?: boolean;
	},
): ResolvedModelConfig => {
	const current = mergeModelOverride(baseConfig, state.sessionModelOverride);
	state.sessionModelOverride = {
		provider: next.provider,
		name: next.name,
		reasoning: next.reasoning ?? current.reasoning,
		fast: next.fast ?? current.fast,
	};
	return mergeModelOverride(baseConfig, state.sessionModelOverride);
};

export const clearSessionModelOverride = (state: RuntimeState): void => {
	state.sessionModelOverride = null;
};
