import { promises as fs } from "node:fs";
import path from "node:path";
import type {
	CodeliaConfig,
	ConfigWriteGroup,
	ConfigWriteScope,
	McpServerConfig,
	PermissionRule,
	PermissionsConfig,
	SearchConfig,
	SkillsConfig,
} from "@codelia/config";
import {
	CONFIG_GROUP_DEFAULT_WRITE_SCOPE,
	configRegistry,
} from "@codelia/config";
import {
	appendPermissionAllowRules as appendPermissionAllowRulesAtPath,
	loadConfig,
	updateModelConfig,
	updateTuiConfig,
} from "@codelia/config-loader";
import { getDefaultSystemPromptPath } from "@codelia/core";
import { StoragePathServiceImpl } from "@codelia/storage";

const DEFAULT_SYSTEM_PROMPT = "You are a coding assistant.";
const DEFAULT_MCP_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_SKILLS_INITIAL_MAX_ENTRIES = 200;
const DEFAULT_SKILLS_INITIAL_MAX_BYTES = 32 * 1024;
const DEFAULT_SKILLS_SEARCH_DEFAULT_LIMIT = 8;
const DEFAULT_SKILLS_SEARCH_MAX_LIMIT = 50;
const DEFAULT_SEARCH_MODE = "auto";
const DEFAULT_SEARCH_NATIVE_PROVIDERS = ["openai", "anthropic"] as const;
const DEFAULT_SEARCH_LOCAL_BACKEND = "ddg";
const DEFAULT_SEARCH_BRAVE_API_KEY_ENV = "BRAVE_SEARCH_API_KEY";

export const readEnvValue = (key: string): string | undefined => {
	const value = process.env[key];
	if (!value) return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
};

export const resolveConfigPath = (): string => {
	const envPath = readEnvValue("CODELIA_CONFIG_PATH");
	if (envPath) return path.resolve(envPath);
	const storage = new StoragePathServiceImpl();
	return storage.resolvePaths().configFile;
};

export const resolveProjectConfigPath = (workingDir: string): string =>
	path.resolve(workingDir, ".codelia", "config.json");

const loadConfigLayers = async (
	workingDir?: string,
): Promise<{
	globalConfig: CodeliaConfig | null;
	projectConfig: CodeliaConfig | null;
}> => {
	const configPath = resolveConfigPath();
	let globalConfig: CodeliaConfig | null = null;
	try {
		globalConfig = await loadConfig(configPath);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to load config.json: ${message}`);
	}

	let projectConfig: CodeliaConfig | null = null;
	if (workingDir) {
		const projectPath = resolveProjectConfigPath(workingDir);
		try {
			projectConfig = await loadConfig(projectPath);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Failed to load project config.json: ${message}`);
		}
	}

	return { globalConfig, projectConfig };
};

export const resolveConfigLayers = async (
	workingDir?: string,
): Promise<{
	globalConfig: CodeliaConfig | null;
	projectConfig: CodeliaConfig | null;
}> => loadConfigLayers(workingDir);

export const resolveModelConfig = async (
	workingDir?: string,
): Promise<{
	provider?: string;
	name?: string;
	reasoning?: string;
	verbosity?: string;
}> => {
	const { globalConfig, projectConfig } = await loadConfigLayers(workingDir);
	const effective = configRegistry.resolve([globalConfig, projectConfig]);
	return {
		provider: effective.model?.provider,
		name: effective.model?.name,
		reasoning: effective.model?.reasoning,
		verbosity: effective.model?.verbosity,
	};
};

export const resolveTuiConfig = async (
	workingDir?: string,
): Promise<{
	theme?: string;
}> => {
	const { globalConfig, projectConfig } = await loadConfigLayers(workingDir);
	const effective = configRegistry.resolve([globalConfig, projectConfig]);
	return {
		theme: effective.tui?.theme,
	};
};

export const resolvePermissionsConfig = async (
	workingDir?: string,
): Promise<PermissionsConfig | undefined> => {
	const { globalConfig, projectConfig } = await loadConfigLayers(workingDir);
	const effective = configRegistry.resolve([globalConfig, projectConfig]);
	return effective.permissions;
};

export type ResolvedSkillsConfig = {
	enabled: boolean;
	initial: {
		maxEntries: number;
		maxBytes: number;
	};
	search: {
		defaultLimit: number;
		maxLimit: number;
	};
};

const resolveSkillsLimit = (
	value: number | undefined,
	fallback: number,
): number => {
	if (!value || !Number.isFinite(value) || value <= 0) {
		return fallback;
	}
	return Math.max(1, Math.trunc(value));
};

const normalizeSkillsConfig = (
	value: SkillsConfig | undefined,
): ResolvedSkillsConfig => {
	const maxEntries = resolveSkillsLimit(
		value?.initial?.maxEntries,
		DEFAULT_SKILLS_INITIAL_MAX_ENTRIES,
	);
	const maxBytes = resolveSkillsLimit(
		value?.initial?.maxBytes,
		DEFAULT_SKILLS_INITIAL_MAX_BYTES,
	);
	const defaultLimit = resolveSkillsLimit(
		value?.search?.defaultLimit,
		DEFAULT_SKILLS_SEARCH_DEFAULT_LIMIT,
	);
	const maxLimitCandidate = resolveSkillsLimit(
		value?.search?.maxLimit,
		DEFAULT_SKILLS_SEARCH_MAX_LIMIT,
	);
	const maxLimit = Math.max(defaultLimit, maxLimitCandidate);
	return {
		enabled: value?.enabled !== false,
		initial: {
			maxEntries,
			maxBytes,
		},
		search: {
			defaultLimit,
			maxLimit,
		},
	};
};

export const resolveSkillsConfig = async (
	workingDir?: string,
): Promise<ResolvedSkillsConfig> => {
	const { globalConfig, projectConfig } = await loadConfigLayers(workingDir);
	const effective = configRegistry.resolve([globalConfig, projectConfig]);
	return normalizeSkillsConfig(effective.skills);
};

export type ResolvedSearchConfig = {
	mode: "auto" | "native" | "local";
	native: {
		providers: string[];
		searchContextSize?: "low" | "medium" | "high";
		allowedDomains?: string[];
		userLocation?: {
			city?: string;
			country?: string;
			region?: string;
			timezone?: string;
		};
	};
	local: {
		backend: "ddg" | "brave";
		braveApiKeyEnv: string;
	};
};

const normalizeSearchConfig = (
	value: SearchConfig | undefined,
): ResolvedSearchConfig => {
	const mode =
		value?.mode === "auto" ||
		value?.mode === "native" ||
		value?.mode === "local"
			? value.mode
			: DEFAULT_SEARCH_MODE;
	const providersRaw = value?.native?.providers ?? [
		...DEFAULT_SEARCH_NATIVE_PROVIDERS,
	];
	const providers = Array.from(
		new Set(
			providersRaw
				.map((entry) => entry.trim())
				.filter((entry) => entry.length > 0),
		),
	);
	const searchContextSize = value?.native?.search_context_size;
	const allowedDomains = value?.native?.allowed_domains?.length
		? value.native.allowed_domains
				.map((entry) => entry.trim())
				.filter((entry) => entry.length > 0)
		: undefined;
	const userLocation = value?.native?.user_location
		? {
				...(value.native.user_location.city
					? { city: value.native.user_location.city }
					: {}),
				...(value.native.user_location.country
					? { country: value.native.user_location.country }
					: {}),
				...(value.native.user_location.region
					? { region: value.native.user_location.region }
					: {}),
				...(value.native.user_location.timezone
					? { timezone: value.native.user_location.timezone }
					: {}),
			}
		: undefined;
	const backend =
		value?.local?.backend === "ddg" || value?.local?.backend === "brave"
			? value.local.backend
			: DEFAULT_SEARCH_LOCAL_BACKEND;
	const braveApiKeyEnv =
		value?.local?.brave_api_key_env?.trim() || DEFAULT_SEARCH_BRAVE_API_KEY_ENV;
	return {
		mode,
		native: {
			providers: providers.length
				? providers
				: [...DEFAULT_SEARCH_NATIVE_PROVIDERS],
			...(searchContextSize ? { searchContextSize } : {}),
			...(allowedDomains?.length ? { allowedDomains } : {}),
			...(userLocation && Object.keys(userLocation).length
				? { userLocation }
				: {}),
		},
		local: {
			backend,
			braveApiKeyEnv,
		},
	};
};

export const resolveSearchConfig = async (
	workingDir?: string,
): Promise<ResolvedSearchConfig> => {
	const { globalConfig, projectConfig } = await loadConfigLayers(workingDir);
	const effective = configRegistry.resolve([globalConfig, projectConfig]);
	return normalizeSearchConfig(effective.search);
};

export type ResolvedMcpServerConfig = McpServerConfig & {
	id: string;
	source: "project" | "global";
	enabled: boolean;
	request_timeout_ms: number;
};

const normalizeMcpTimeoutMs = (value: unknown): number => {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		return DEFAULT_MCP_REQUEST_TIMEOUT_MS;
	}
	return Math.round(value);
};

export const resolveMcpServers = async (
	workingDir?: string,
): Promise<ResolvedMcpServerConfig[]> => {
	const { globalConfig, projectConfig } = await loadConfigLayers(workingDir);
	const globalServers = globalConfig?.mcp?.servers ?? {};
	const projectServers = projectConfig?.mcp?.servers ?? {};
	const allIds = new Set<string>([
		...Object.keys(globalServers),
		...Object.keys(projectServers),
	]);
	const resolved: ResolvedMcpServerConfig[] = [];
	for (const id of allIds) {
		const project = projectServers[id];
		const global = globalServers[id];
		const server = project ?? global;
		if (!server) continue;
		resolved.push({
			...server,
			id,
			source: project ? "project" : "global",
			enabled: server.enabled !== false,
			request_timeout_ms: normalizeMcpTimeoutMs(server.request_timeout_ms),
		});
	}
	return resolved.sort((left, right) => left.id.localeCompare(right.id));
};

export const appendPermissionAllowRules = async (
	workingDir: string,
	rules: PermissionRule[],
): Promise<void> => {
	if (!rules.length) return;
	const configPath = resolveProjectConfigPath(workingDir);
	await appendPermissionAllowRulesAtPath(configPath, rules);
};

export const appendPermissionAllowRule = async (
	workingDir: string,
	rule: PermissionRule,
): Promise<void> => {
	await appendPermissionAllowRules(workingDir, [rule]);
};

export type WriteScope = "global" | "project";

export type WriteTarget = {
	scope: WriteScope;
	path: string;
};

const hasDefinedGroup = (
	group: ConfigWriteGroup,
	value: CodeliaConfig | null | undefined,
): boolean => {
	switch (group) {
		case "model":
			return (
				typeof value?.model?.name === "string" &&
				value.model.name.trim().length > 0
			);
		case "permissions":
			return (
				Array.isArray(value?.permissions?.allow) ||
				Array.isArray(value?.permissions?.deny)
			);
		case "tui":
			return (
				typeof value?.tui?.theme === "string" &&
				value.tui.theme.trim().length > 0
			);
		default:
			return false;
	}
};

const resolveWriteTarget = async (
	workingDir: string,
	group: ConfigWriteGroup,
): Promise<WriteTarget> => {
	const globalPath = resolveConfigPath();
	const projectPath = resolveProjectConfigPath(workingDir);
	const [globalConfig, projectConfig] = await Promise.all([
		loadConfig(globalPath),
		loadConfig(projectPath),
	]);

	if (hasDefinedGroup(group, projectConfig)) {
		return { scope: "project", path: projectPath };
	}
	if (hasDefinedGroup(group, globalConfig)) {
		return { scope: "global", path: globalPath };
	}
	const defaultScope: ConfigWriteScope =
		CONFIG_GROUP_DEFAULT_WRITE_SCOPE[group];
	return defaultScope === "project"
		? { scope: "project", path: projectPath }
		: { scope: "global", path: globalPath };
};

export const updateModel = async (
	workingDir: string,
	model: { provider: string; name: string },
): Promise<WriteTarget> => {
	const target = await resolveWriteTarget(workingDir, "model");
	await updateModelConfig(target.path, model);
	return target;
};

export const updateTuiTheme = async (
	workingDir: string,
	theme: string,
): Promise<WriteTarget> => {
	const target = await resolveWriteTarget(workingDir, "tui");
	await updateTuiConfig(target.path, { theme });
	return target;
};

export const resolveReasoningEffort = (
	value?: string,
): "low" | "medium" | "high" | undefined => {
	return resolveModelLevelOption(value, "model.reasoning");
};

export const resolveTextVerbosity = (
	value?: string,
): "low" | "medium" | "high" | undefined => {
	return resolveModelLevelOption(value, "model.verbosity");
};

const resolveModelLevelOption = (
	value: string | undefined,
	fieldName: "model.reasoning" | "model.verbosity",
): "low" | "medium" | "high" | undefined => {
	if (!value) return undefined;
	const normalized = value.trim().toLowerCase();
	if (
		normalized === "low" ||
		normalized === "medium" ||
		normalized === "high"
	) {
		return normalized;
	}
	throw new Error(`Invalid ${fieldName}: ${value}. Expected low|medium|high.`);
};

export const loadSystemPrompt = async (workingDir: string): Promise<string> => {
	const promptPath = process.env.CODELIA_SYSTEM_PROMPT_PATH
		? path.resolve(process.env.CODELIA_SYSTEM_PROMPT_PATH)
		: getDefaultSystemPromptPath();
	try {
		const raw = await fs.readFile(promptPath, "utf8");
		const trimmed = raw.trim();
		if (!trimmed) {
			return `${DEFAULT_SYSTEM_PROMPT}\nWorking directory: ${workingDir}`;
		}
		return trimmed.includes("{{working_dir}}")
			? trimmed.replaceAll("{{working_dir}}", workingDir)
			: `${trimmed}\n\nWorking directory: ${workingDir}`;
	} catch {
		return `${DEFAULT_SYSTEM_PROMPT}\nWorking directory: ${workingDir}`;
	}
};
