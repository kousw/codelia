import { type ResolvedModelConfig, resolveModelConfig } from "./config";
import type {
	RuntimeModelOverride,
	RuntimeModelSource,
	RuntimeState,
} from "./runtime-state";

type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | undefined;
const MODEL_OVERRIDE_SESSION_META_KEY = "codelia_model_override";

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const pickString = (value: unknown): string | undefined =>
	typeof value === "string" && value.trim() ? value.trim() : undefined;

export const readSessionModelOverride = (
	meta: Record<string, unknown> | undefined,
): RuntimeModelOverride | null => {
	const raw = meta?.[MODEL_OVERRIDE_SESSION_META_KEY];
	if (!isRecord(raw)) return null;
	const provider = pickString(raw.provider);
	const name = pickString(raw.name);
	const reasoning = pickString(raw.reasoning);
	if (!provider || !name) return null;
	return {
		provider,
		name,
		...(reasoning ? { reasoning } : {}),
		...(typeof raw.fast === "boolean" ? { fast: raw.fast } : {}),
	};
};

export const mergeSessionModelOverrideIntoMeta = (
	meta: Record<string, unknown> | undefined,
	override: RuntimeModelOverride | null,
): Record<string, unknown> | undefined => {
	const nextMeta = meta ? { ...meta } : {};
	if (override?.provider && override.name) {
		nextMeta[MODEL_OVERRIDE_SESSION_META_KEY] = {
			provider: override.provider,
			name: override.name,
			...(override.reasoning ? { reasoning: override.reasoning } : {}),
			...(override.fast !== undefined ? { fast: override.fast } : {}),
		};
	} else {
		delete nextMeta[MODEL_OVERRIDE_SESSION_META_KEY];
	}
	return Object.keys(nextMeta).length > 0 ? nextMeta : undefined;
};

export const applySessionModelOverrideFromMeta = (
	state: RuntimeState,
	meta: Record<string, unknown> | undefined,
): void => {
	state.sessionModelOverride = readSessionModelOverride(meta);
};
