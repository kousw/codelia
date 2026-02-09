import path from "node:path";
import {
	loadMcpServers,
	removeMcpServerConfig,
	setMcpServerEnabled,
	upsertMcpServerConfig,
} from "@codelia/config-loader";
import { resolveStoragePaths } from "@codelia/storage";
import { z } from "zod";
import {
	getAllFlagValues,
	getLastFlagValue,
	hasBooleanFlag,
	type ParsedArgs,
	parseBoolean,
	parseCliArgs,
	parseKeyValue,
	parseTimeout,
} from "../args";
import { readMcpAuth } from "../mcp/auth-file";
import { probeServer } from "../mcp/probe";
import type {
	McpServerConfig,
	Scope,
	ServerEntry,
	ServerSource,
} from "../mcp/types";

const TIMEOUT_SCHEMA = z
	.number()
	.positive()
	.transform((value) => Math.round(value));
const OAUTH_SCHEMA = z
	.object({
		authorization_url: z.string(),
		token_url: z.string(),
		registration_url: z.string(),
		client_id: z.string(),
		client_secret: z.string(),
		scope: z.string(),
	})
	.partial();
const HTTP_SERVER_CONFIG_SCHEMA = z.object({
	transport: z.literal("http"),
	enabled: z.boolean().optional(),
	url: z.string(),
	headers: z.record(z.string(), z.string()).optional(),
	env: z.record(z.string(), z.string()).optional(),
	request_timeout_ms: TIMEOUT_SCHEMA.optional(),
	oauth: OAUTH_SCHEMA.optional(),
});
const STDIO_SERVER_CONFIG_SCHEMA = z.object({
	transport: z.literal("stdio"),
	enabled: z.boolean().optional(),
	command: z.string(),
	args: z.array(z.string()).optional(),
	cwd: z.string().optional(),
	env: z.record(z.string(), z.string()).optional(),
	request_timeout_ms: TIMEOUT_SCHEMA.optional(),
	oauth: OAUTH_SCHEMA.optional(),
});
const MCP_SERVER_CONFIG_SCHEMA = z.union([
	HTTP_SERVER_CONFIG_SCHEMA,
	STDIO_SERVER_CONFIG_SCHEMA,
]);

const describeError = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

const readEnvValue = (key: string): string | undefined => {
	const value = process.env[key];
	if (!value) return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
};

const resolveGlobalConfigPath = (): string => {
	const envPath = readEnvValue("CODELIA_CONFIG_PATH");
	if (envPath) return path.resolve(envPath);
	const storage = resolveStoragePaths();
	return storage.configFile;
};

const resolveProjectConfigPath = (): string =>
	path.resolve(process.cwd(), ".codelia", "config.json");

const normalizeServerConfig = (value: unknown): McpServerConfig | null => {
	const parsed = MCP_SERVER_CONFIG_SCHEMA.safeParse(value);
	return parsed.success ? (parsed.data as McpServerConfig) : null;
};

const normalizeEntries = (
	servers: Record<string, McpServerConfig>,
	source: ServerSource,
): ServerEntry[] => {
	const entries: ServerEntry[] = [];
	for (const [id, rawConfig] of Object.entries(servers)) {
		const config = normalizeServerConfig(rawConfig);
		if (!config) continue;
		entries.push({ id, config, source });
	}
	return entries.sort((left, right) => left.id.localeCompare(right.id));
};

const loadEntriesByScope = async (scope: Scope): Promise<ServerEntry[]> => {
	const globalServers = await loadMcpServers(resolveGlobalConfigPath());
	const projectServers = await loadMcpServers(resolveProjectConfigPath());
	if (scope === "global") {
		return normalizeEntries(globalServers, "global");
	}
	if (scope === "project") {
		return normalizeEntries(projectServers, "project");
	}
	const merged = new Map<string, ServerEntry>();
	for (const entry of normalizeEntries(globalServers, "global")) {
		merged.set(entry.id, entry);
	}
	for (const entry of normalizeEntries(projectServers, "project")) {
		merged.set(entry.id, entry);
	}
	return Array.from(merged.values()).sort((left, right) =>
		left.id.localeCompare(right.id),
	);
};

const resolveMutableScope = (parsed: ParsedArgs): "project" | "global" => {
	const scopeRaw = getLastFlagValue(parsed, "scope") ?? "project";
	if (scopeRaw === "project" || scopeRaw === "global") {
		return scopeRaw;
	}
	throw new Error("--scope must be project|global");
};

const resolveListScope = (parsed: ParsedArgs): Scope => {
	const scopeRaw = getLastFlagValue(parsed, "scope") ?? "effective";
	if (
		scopeRaw === "project" ||
		scopeRaw === "global" ||
		scopeRaw === "effective"
	) {
		return scopeRaw;
	}
	throw new Error("--scope must be effective|project|global");
};

const buildServerConfigFromAdd = (parsed: ParsedArgs): McpServerConfig => {
	const transport = getLastFlagValue(parsed, "transport");
	if (transport !== "http" && transport !== "stdio") {
		throw new Error("--transport must be http|stdio");
	}
	const enabledRaw = getLastFlagValue(parsed, "enabled");
	const enabled = enabledRaw ? parseBoolean(enabledRaw, "--enabled") : true;
	const timeoutRaw = getLastFlagValue(parsed, "request-timeout-ms");
	const requestTimeoutMs = timeoutRaw ? parseTimeout(timeoutRaw) : undefined;
	const oauth = {
		authorization_url: getLastFlagValue(parsed, "oauth-authorization-url"),
		token_url: getLastFlagValue(parsed, "oauth-token-url"),
		registration_url: getLastFlagValue(parsed, "oauth-registration-url"),
		client_id: getLastFlagValue(parsed, "oauth-client-id"),
		client_secret: getLastFlagValue(parsed, "oauth-client-secret"),
		scope: getLastFlagValue(parsed, "oauth-scope"),
	};
	const oauthConfig = Object.fromEntries(
		Object.entries(oauth).filter(([, value]) => !!value),
	) as McpServerConfig["oauth"];

	if (transport === "http") {
		const url = getLastFlagValue(parsed, "url");
		if (!url) throw new Error("--url is required when --transport=http");
		const headers = Object.fromEntries(
			getAllFlagValues(parsed, "header").map((value) =>
				parseKeyValue(value, "--header"),
			),
		);
		return {
			transport,
			...(enabled !== true ? { enabled } : {}),
			url,
			...(Object.keys(headers).length ? { headers } : {}),
			...(requestTimeoutMs ? { request_timeout_ms: requestTimeoutMs } : {}),
			...(oauthConfig && Object.keys(oauthConfig).length
				? { oauth: oauthConfig }
				: {}),
		};
	}

	const command = getLastFlagValue(parsed, "command");
	if (!command) {
		throw new Error("--command is required when --transport=stdio");
	}
	const env = Object.fromEntries(
		getAllFlagValues(parsed, "env").map((value) =>
			parseKeyValue(value, "--env"),
		),
	);
	const args = getAllFlagValues(parsed, "arg");
	const cwd = getLastFlagValue(parsed, "cwd");
	return {
		transport,
		...(enabled !== true ? { enabled } : {}),
		command,
		...(args.length ? { args } : {}),
		...(cwd ? { cwd } : {}),
		...(Object.keys(env).length ? { env } : {}),
		...(requestTimeoutMs ? { request_timeout_ms: requestTimeoutMs } : {}),
		...(oauthConfig && Object.keys(oauthConfig).length
			? { oauth: oauthConfig }
			: {}),
	};
};

const printStaticList = (entries: ServerEntry[]): void => {
	if (!entries.length) {
		console.log("no MCP servers configured");
		return;
	}
	console.log("id\ttransport\tsource\tenabled");
	for (const entry of entries) {
		const enabled = entry.config.enabled !== false;
		console.log(
			`${entry.id}\t${entry.config.transport}\t${entry.source}\t${enabled}`,
		);
	}
};

export const runMcpConfigCommand = async (
	subcommand: string,
	rest: string[],
): Promise<number> => {
	const parsed = parseCliArgs(rest);

	if (subcommand === "list") {
		const scope = resolveListScope(parsed);
		const entries = await loadEntriesByScope(scope);
		printStaticList(entries);
		return 0;
	}

	if (subcommand === "add") {
		const serverId = parsed.positionals[0];
		if (!serverId) {
			console.error(
				"usage: codelia mcp add <server-id> --transport <http|stdio> ...",
			);
			return 1;
		}
		const scope = resolveMutableScope(parsed);
		const configPath =
			scope === "global"
				? resolveGlobalConfigPath()
				: resolveProjectConfigPath();
		const servers = await loadMcpServers(configPath);
		const replace = hasBooleanFlag(parsed, "replace");
		if (servers[serverId] !== undefined && !replace) {
			console.error(`server already exists in ${scope} scope: ${serverId}`);
			console.error("pass --replace to overwrite");
			return 1;
		}
		const serverConfig = buildServerConfigFromAdd(parsed);
		await upsertMcpServerConfig(configPath, serverId, serverConfig);
		console.log(`added MCP server '${serverId}' (${scope})`);
		return 0;
	}

	if (
		subcommand === "remove" ||
		subcommand === "enable" ||
		subcommand === "disable"
	) {
		const serverId = parsed.positionals[0];
		if (!serverId) {
			console.error(
				`usage: codelia mcp ${subcommand} <server-id> [--scope project|global]`,
			);
			return 1;
		}
		const scope = resolveMutableScope(parsed);
		const configPath =
			scope === "global"
				? resolveGlobalConfigPath()
				: resolveProjectConfigPath();
		if (subcommand === "remove") {
			const removed = await removeMcpServerConfig(configPath, serverId);
			if (!removed) {
				console.error(`server not found in ${scope} scope: ${serverId}`);
				return 1;
			}
		} else {
			const updated = await setMcpServerEnabled(
				configPath,
				serverId,
				subcommand === "enable",
			);
			if (!updated) {
				console.error(`server not found in ${scope} scope: ${serverId}`);
				return 1;
			}
		}
		console.log(`${subcommand}d MCP server '${serverId}' (${scope})`);
		return 0;
	}

	if (subcommand === "test") {
		const serverId = parsed.positionals[0];
		if (!serverId) {
			console.error(
				"usage: codelia mcp test <server-id> [--scope effective|project|global]",
			);
			return 1;
		}
		const scope = resolveListScope(parsed);
		const entries = await loadEntriesByScope(scope);
		const target = entries.find((entry) => entry.id === serverId);
		if (!target) {
			console.error(`server not found: ${serverId} (scope=${scope})`);
			return 1;
		}
		try {
			const auth = await readMcpAuth();
			const accessToken = auth.servers[target.id]?.access_token;
			const configForTest: McpServerConfig =
				target.config.transport === "http" && accessToken
					? {
							...target.config,
							headers: {
								...(target.config.headers ?? {}),
								Authorization: `Bearer ${accessToken}`,
							},
						}
					: target.config;
			const tools = await probeServer(configForTest);
			console.log(
				`MCP test succeeded: id=${target.id} transport=${target.config.transport} source=${target.source} tools=${tools}`,
			);
			return 0;
		} catch (error) {
			console.error(
				`MCP test failed: id=${target.id} transport=${target.config.transport}: ${describeError(error)}`,
			);
			return 1;
		}
	}

	return -1;
};
