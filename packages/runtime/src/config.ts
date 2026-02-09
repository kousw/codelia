import { promises as fs } from "node:fs";
import path from "node:path";
import type {
	CodeliaConfig,
	McpServerConfig,
	PermissionRule,
	PermissionsConfig,
	SkillsConfig,
} from "@codelia/config";
import { configRegistry } from "@codelia/config";
import {
	appendPermissionAllowRules as appendPermissionAllowRulesAtPath,
	loadConfig,
} from "@codelia/config-loader";
import { getDefaultSystemPromptPath } from "@codelia/core";
import { StoragePathServiceImpl } from "@codelia/storage";

const DEFAULT_SYSTEM_PROMPT = "You are a coding assistant.";
const DEFAULT_MCP_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_SKILLS_INITIAL_MAX_ENTRIES = 200;
const DEFAULT_SKILLS_INITIAL_MAX_BYTES = 32 * 1024;
const DEFAULT_SKILLS_SEARCH_DEFAULT_LIMIT = 8;
const DEFAULT_SKILLS_SEARCH_MAX_LIMIT = 50;

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
