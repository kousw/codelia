import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
	CodeliaConfig,
	McpServerConfig,
	ModelConfig,
	PermissionRule,
} from "@codelia/config";
import { CONFIG_VERSION, parseConfig } from "@codelia/config";
import { cosmiconfig } from "cosmiconfig";

const MODULE_NAME = "codelia";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isMissingFileError = (error: unknown): boolean =>
	typeof error === "object" &&
	error !== null &&
	"code" in error &&
	(error as { code?: string }).code === "ENOENT";

const pickDefined = (value: Record<string, unknown>): Record<string, unknown> =>
	Object.fromEntries(
		Object.entries(value).filter(([, entry]) => entry !== undefined),
	);

const pickString = (value: unknown): string | undefined =>
	typeof value === "string" ? value : undefined;

const readConfigRaw = async (
	configPath: string,
): Promise<Record<string, unknown> | null> => {
	let raw: string;
	try {
		raw = await readFile(configPath, "utf8");
	} catch (error) {
		if (isMissingFileError(error)) return null;
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to parse config.json: ${message}`);
	}
	if (!isRecord(parsed)) {
		throw new Error("config.json must be a JSON object");
	}
	return parsed;
};

const ensureVersion = (
	raw: Record<string, unknown>,
	configPath: string,
): number => {
	const version = raw.version ?? CONFIG_VERSION;
	if (version !== CONFIG_VERSION) {
		throw new Error(`${configPath}: unsupported version ${String(version)}`);
	}
	return version as number;
};

const writeConfigRaw = async (
	configPath: string,
	raw: Record<string, unknown>,
): Promise<void> => {
	await mkdir(path.dirname(configPath), { recursive: true });
	await writeFile(configPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
};

const getRawMcpServerMap = (
	raw: Record<string, unknown>,
): Record<string, unknown> => {
	if (!isRecord(raw.mcp)) return {};
	const servers = raw.mcp.servers;
	if (!isRecord(servers)) return {};
	return { ...servers };
};

const setRawMcpServerMap = (
	raw: Record<string, unknown>,
	servers: Record<string, unknown>,
): Record<string, unknown> => {
	const next: Record<string, unknown> = { ...raw, version: CONFIG_VERSION };
	if (!Object.keys(servers).length) {
		if (isRecord(next.mcp)) {
			const mcp = { ...next.mcp };
			delete mcp.servers;
			if (Object.keys(mcp).length === 0) {
				delete next.mcp;
			} else {
				next.mcp = mcp;
			}
		}
		return next;
	}
	const currentMcp = isRecord(next.mcp) ? next.mcp : {};
	next.mcp = {
		...currentMcp,
		servers,
	};
	return next;
};

const isSameRule = (entry: unknown, rule: PermissionRule): boolean => {
	if (!isRecord(entry)) return false;
	const tool = pickString(entry.tool);
	if (tool !== rule.tool) return false;
	const command = pickString(entry.command);
	const commandGlob = pickString(entry.command_glob);
	const skillName = pickString(entry.skill_name);
	return (
		command === rule.command &&
		commandGlob === rule.command_glob &&
		skillName === rule.skill_name
	);
};

export const loadConfig = async (
	configPath: string,
): Promise<CodeliaConfig | null> => {
	const explorer = cosmiconfig(MODULE_NAME);
	let result: { config: unknown; filepath: string } | null = null;
	try {
		result = await explorer.load(configPath);
	} catch (error) {
		if (isMissingFileError(error)) return null;
		throw error;
	}
	if (!result?.config) return null;
	return parseConfig(result.config, result.filepath);
};

export const updateModelConfig = async (
	configPath: string,
	model: ModelConfig,
): Promise<CodeliaConfig> => {
	const raw = (await readConfigRaw(configPath)) ?? {};
	const version = ensureVersion(raw, configPath);
	const currentModel = isRecord(raw.model) ? raw.model : {};
	const nextModel = {
		...currentModel,
		...pickDefined(model as Record<string, unknown>),
	};
	const nextRaw: Record<string, unknown> = {
		...raw,
		version,
		model: nextModel,
	};
	await writeConfigRaw(configPath, nextRaw);
	return parseConfig(nextRaw, configPath);
};

export const loadMcpServers = async (
	configPath: string,
): Promise<Record<string, McpServerConfig>> => {
	const config = await loadConfig(configPath);
	return config?.mcp?.servers ?? {};
};

export const upsertMcpServerConfig = async (
	configPath: string,
	serverId: string,
	server: McpServerConfig,
): Promise<CodeliaConfig> => {
	const raw = (await readConfigRaw(configPath)) ?? {};
	const version = ensureVersion(raw, configPath);
	const servers = getRawMcpServerMap(raw);
	servers[serverId] = server;
	const nextRaw = setRawMcpServerMap({ ...raw, version }, servers);
	await writeConfigRaw(configPath, nextRaw);
	return parseConfig(nextRaw, configPath);
};

export const removeMcpServerConfig = async (
	configPath: string,
	serverId: string,
): Promise<boolean> => {
	const raw = await readConfigRaw(configPath);
	if (!raw) return false;
	const version = ensureVersion(raw, configPath);
	const servers = getRawMcpServerMap(raw);
	if (servers[serverId] === undefined) {
		return false;
	}
	delete servers[serverId];
	const nextRaw = setRawMcpServerMap({ ...raw, version }, servers);
	await writeConfigRaw(configPath, nextRaw);
	return true;
};

export const setMcpServerEnabled = async (
	configPath: string,
	serverId: string,
	enabled: boolean,
): Promise<boolean> => {
	const raw = await readConfigRaw(configPath);
	if (!raw) return false;
	const version = ensureVersion(raw, configPath);
	const servers = getRawMcpServerMap(raw);
	if (servers[serverId] === undefined) {
		return false;
	}
	const current = isRecord(servers[serverId]) ? { ...servers[serverId] } : {};
	current.enabled = enabled;
	servers[serverId] = current;
	const nextRaw = setRawMcpServerMap({ ...raw, version }, servers);
	await writeConfigRaw(configPath, nextRaw);
	return true;
};

export const appendPermissionAllowRules = async (
	configPath: string,
	rules: PermissionRule[],
): Promise<CodeliaConfig> => {
	const raw = (await readConfigRaw(configPath)) ?? {};
	const version = ensureVersion(raw, configPath);
	const permissions = isRecord(raw.permissions) ? raw.permissions : {};
	const allow = Array.isArray(permissions.allow) ? permissions.allow : [];
	for (const rule of rules) {
		if (!allow.some((entry) => isSameRule(entry, rule))) {
			allow.push(rule);
		}
	}
	const nextPermissions: Record<string, unknown> = {
		...permissions,
		allow,
	};
	const nextRaw: Record<string, unknown> = {
		...raw,
		version,
		permissions: nextPermissions,
	};
	await writeConfigRaw(configPath, nextRaw);
	return parseConfig(nextRaw, configPath);
};

export const appendPermissionAllowRule = async (
	configPath: string,
	rule: PermissionRule,
): Promise<CodeliaConfig> => {
	return appendPermissionAllowRules(configPath, [rule]);
};
