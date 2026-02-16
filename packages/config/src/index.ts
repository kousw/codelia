export type ModelConfig = {
	provider?: string;
	name?: string;
	reasoning?: string;
	verbosity?: string;
};

export type PermissionRule = {
	tool: string;
	command?: string;
	command_glob?: string;
	skill_name?: string;
};

export type PermissionsConfig = {
	allow?: PermissionRule[];
	deny?: PermissionRule[];
};

export type McpServerConfig = {
	transport: "stdio" | "http";
	enabled?: boolean;
	command?: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
	url?: string;
	headers?: Record<string, string>;
	request_timeout_ms?: number;
	oauth?: {
		authorization_url?: string;
		token_url?: string;
		registration_url?: string;
		client_id?: string;
		client_secret?: string;
		scope?: string;
	};
};

export type McpConfig = {
	servers: Record<string, McpServerConfig>;
};

export type SkillsConfig = {
	enabled?: boolean;
	initial?: {
		maxEntries?: number;
		maxBytes?: number;
	};
	search?: {
		defaultLimit?: number;
		maxLimit?: number;
	};
};

export type SearchMode = "auto" | "native" | "local";

export type SearchConfig = {
	mode?: SearchMode;
	native?: {
		providers?: string[];
		search_context_size?: "low" | "medium" | "high";
		allowed_domains?: string[];
		user_location?: {
			city?: string;
			country?: string;
			region?: string;
			timezone?: string;
		};
	};
	local?: {
		backend?: "ddg" | "brave";
		brave_api_key_env?: string;
	};
};

export type CodeliaConfig = {
	version: number;
	model?: ModelConfig;
	permissions?: PermissionsConfig;
	mcp?: McpConfig;
	skills?: SkillsConfig;
	search?: SearchConfig;
};

export const CONFIG_VERSION = 1;
const MCP_SERVER_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const pickString = (value: unknown): string | undefined =>
	typeof value === "string" ? value : undefined;

const pickBoolean = (value: unknown): boolean | undefined =>
	typeof value === "boolean" ? value : undefined;

const pickNumber = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;

const pickPositiveInt = (value: unknown): number | undefined => {
	const num = pickNumber(value);
	if (num === undefined) return undefined;
	if (!Number.isInteger(num) || num <= 0) return undefined;
	return num;
};

const pickStringArray = (value: unknown): string[] | undefined => {
	if (!Array.isArray(value)) return undefined;
	const values = value.filter(
		(entry): entry is string => typeof entry === "string",
	);
	return values.length ? values : undefined;
};

const pickStringRecord = (
	value: unknown,
): Record<string, string> | undefined => {
	if (!isRecord(value)) return undefined;
	const entries = Object.entries(value).filter(
		([, entry]) => typeof entry === "string",
	) as Array<[string, string]>;
	if (!entries.length) return undefined;
	return Object.fromEntries(entries);
};

const parsePermissionRule = (value: unknown): PermissionRule | null => {
	if (!isRecord(value)) return null;
	const tool = pickString(value.tool);
	if (!tool) return null;
	const command = pickString(value.command);
	const commandGlob = pickString(value.command_glob);
	const rawSkillName = pickString(value.skill_name)?.trim().toLowerCase();
	const skillName =
		rawSkillName && SKILL_NAME_PATTERN.test(rawSkillName)
			? rawSkillName
			: undefined;
	return {
		tool,
		...(command ? { command } : {}),
		...(commandGlob ? { command_glob: commandGlob } : {}),
		...(skillName ? { skill_name: skillName } : {}),
	};
};

const parsePermissionRules = (value: unknown): PermissionRule[] | undefined => {
	if (!Array.isArray(value)) return undefined;
	const rules = value
		.map((entry) => parsePermissionRule(entry))
		.filter((entry): entry is PermissionRule => !!entry);
	return rules.length ? rules : undefined;
};

const parseMcpServerConfig = (value: unknown): McpServerConfig | null => {
	if (!isRecord(value)) return null;
	const transport =
		value.transport === "http" || value.transport === "stdio"
			? value.transport
			: undefined;
	if (!transport) return null;
	const enabled = pickBoolean(value.enabled);
	const requestTimeoutMs = pickNumber(value.request_timeout_ms);
	const oauth = isRecord(value.oauth)
		? {
				...(pickString(value.oauth.authorization_url)
					? { authorization_url: pickString(value.oauth.authorization_url) }
					: {}),
				...(pickString(value.oauth.token_url)
					? { token_url: pickString(value.oauth.token_url) }
					: {}),
				...(pickString(value.oauth.registration_url)
					? { registration_url: pickString(value.oauth.registration_url) }
					: {}),
				...(pickString(value.oauth.client_id)
					? { client_id: pickString(value.oauth.client_id) }
					: {}),
				...(pickString(value.oauth.client_secret)
					? { client_secret: pickString(value.oauth.client_secret) }
					: {}),
				...(pickString(value.oauth.scope)
					? { scope: pickString(value.oauth.scope) }
					: {}),
			}
		: undefined;

	if (transport === "http") {
		const url = pickString(value.url);
		if (!url) return null;
		return {
			transport: "http",
			...(enabled !== undefined ? { enabled } : {}),
			url,
			...(pickStringRecord(value.headers)
				? { headers: pickStringRecord(value.headers) }
				: {}),
			...(pickStringRecord(value.env)
				? { env: pickStringRecord(value.env) }
				: {}),
			...(requestTimeoutMs !== undefined
				? { request_timeout_ms: requestTimeoutMs }
				: {}),
			...(oauth && Object.keys(oauth).length ? { oauth } : {}),
		};
	}

	const command = pickString(value.command);
	if (!command) return null;
	return {
		transport: "stdio",
		...(enabled !== undefined ? { enabled } : {}),
		command,
		...(pickStringArray(value.args)
			? { args: pickStringArray(value.args) }
			: {}),
		...(pickString(value.cwd) ? { cwd: pickString(value.cwd) } : {}),
		...(pickStringRecord(value.env)
			? { env: pickStringRecord(value.env) }
			: {}),
		...(requestTimeoutMs !== undefined
			? { request_timeout_ms: requestTimeoutMs }
			: {}),
		...(oauth && Object.keys(oauth).length ? { oauth } : {}),
	};
};

const parseMcpConfig = (value: unknown): McpConfig | undefined => {
	if (!isRecord(value) || !isRecord(value.servers)) return undefined;
	const servers: Record<string, McpServerConfig> = {};
	for (const [serverId, serverValue] of Object.entries(value.servers)) {
		if (!MCP_SERVER_ID_PATTERN.test(serverId)) {
			continue;
		}
		const parsed = parseMcpServerConfig(serverValue);
		if (parsed) {
			servers[serverId] = parsed;
		}
	}
	if (!Object.keys(servers).length) return undefined;
	return { servers };
};

const parseSkillsConfig = (value: unknown): SkillsConfig | undefined => {
	if (!isRecord(value)) return undefined;
	const enabled = pickBoolean(value.enabled);
	const initial = isRecord(value.initial)
		? {
				...(pickPositiveInt(value.initial.maxEntries) !== undefined
					? { maxEntries: pickPositiveInt(value.initial.maxEntries) }
					: {}),
				...(pickPositiveInt(value.initial.maxBytes) !== undefined
					? { maxBytes: pickPositiveInt(value.initial.maxBytes) }
					: {}),
			}
		: undefined;
	const search = isRecord(value.search)
		? {
				...(pickPositiveInt(value.search.defaultLimit) !== undefined
					? { defaultLimit: pickPositiveInt(value.search.defaultLimit) }
					: {}),
				...(pickPositiveInt(value.search.maxLimit) !== undefined
					? { maxLimit: pickPositiveInt(value.search.maxLimit) }
					: {}),
			}
		: undefined;
	const result: SkillsConfig = {};
	if (enabled !== undefined) {
		result.enabled = enabled;
	}
	if (initial && Object.keys(initial).length > 0) {
		result.initial = initial;
	}
	if (search && Object.keys(search).length > 0) {
		result.search = search;
	}
	return Object.keys(result).length > 0 ? result : undefined;
};

const parseSearchMode = (value: unknown): SearchMode | undefined => {
	if (value !== "auto" && value !== "native" && value !== "local") {
		return undefined;
	}
	return value;
};

const parseSearchConfig = (value: unknown): SearchConfig | undefined => {
	if (!isRecord(value)) return undefined;
	const mode = parseSearchMode(value.mode);
	let native: SearchConfig["native"] | undefined;
	if (isRecord(value.native)) {
		const candidate: NonNullable<SearchConfig["native"]> = {};
		const providers = pickStringArray(value.native.providers);
		if (providers) {
			candidate.providers = providers;
		}
		if (
			value.native.search_context_size === "low" ||
			value.native.search_context_size === "medium" ||
			value.native.search_context_size === "high"
		) {
			candidate.search_context_size = value.native.search_context_size;
		}
		const allowedDomains = pickStringArray(value.native.allowed_domains);
		if (allowedDomains) {
			candidate.allowed_domains = allowedDomains;
		}
		if (isRecord(value.native.user_location)) {
			const userLocation: NonNullable<
				NonNullable<SearchConfig["native"]>["user_location"]
			> = {};
			const city = pickString(value.native.user_location.city);
			if (city) userLocation.city = city;
			const country = pickString(value.native.user_location.country);
			if (country) userLocation.country = country;
			const region = pickString(value.native.user_location.region);
			if (region) userLocation.region = region;
			const timezone = pickString(value.native.user_location.timezone);
			if (timezone) userLocation.timezone = timezone;
			if (Object.keys(userLocation).length > 0) {
				candidate.user_location = userLocation;
			}
		}
		if (Object.keys(candidate).length > 0) {
			native = candidate;
		}
	}
	let local: SearchConfig["local"] | undefined;
	if (isRecord(value.local)) {
		const candidate: NonNullable<SearchConfig["local"]> = {};
		if (value.local.backend === "ddg" || value.local.backend === "brave") {
			candidate.backend = value.local.backend;
		}
		const braveKeyEnv = pickString(value.local.brave_api_key_env);
		if (braveKeyEnv) {
			candidate.brave_api_key_env = braveKeyEnv;
		}
		if (Object.keys(candidate).length > 0) {
			local = candidate;
		}
	}
	const result: SearchConfig = {};
	if (mode) {
		result.mode = mode;
	}
	if (native && Object.keys(native).length > 0) {
		result.native = native;
	}
	if (local && Object.keys(local).length > 0) {
		result.local = local;
	}
	return Object.keys(result).length > 0 ? result : undefined;
};

export const parseConfig = (
	value: unknown,
	sourceLabel: string,
): CodeliaConfig => {
	if (!isRecord(value)) {
		throw new Error(`${sourceLabel}: config must be an object`);
	}
	const version = value.version;
	if (version !== CONFIG_VERSION) {
		throw new Error(`${sourceLabel}: unsupported version ${String(version)}`);
	}
	const modelValue = value.model;
	const model = isRecord(modelValue)
		? {
				provider: pickString(modelValue.provider),
				name: pickString(modelValue.name),
				reasoning: pickString(modelValue.reasoning),
				verbosity: pickString(modelValue.verbosity),
			}
		: undefined;
	const permissionsValue = value.permissions;
	const permissions = isRecord(permissionsValue)
		? {
				allow: parsePermissionRules(permissionsValue.allow),
				deny: parsePermissionRules(permissionsValue.deny),
			}
		: undefined;
	const hasPermissions =
		permissions && (permissions.allow || permissions.deny)
			? permissions
			: undefined;
	const mcp = parseMcpConfig(value.mcp);
	const skills = parseSkillsConfig(value.skills);
	const search = parseSearchConfig(value.search);
	const result: CodeliaConfig = { version, model };
	if (hasPermissions) {
		result.permissions = hasPermissions;
	}
	if (mcp) {
		result.mcp = mcp;
	}
	if (skills) {
		result.skills = skills;
	}
	if (search) {
		result.search = search;
	}
	return result;
};

type ConfigLayer = {
	model?: ModelConfig;
	permissions?: PermissionsConfig;
	mcp?: McpConfig;
	skills?: SkillsConfig;
	search?: SearchConfig;
};

export class ConfigRegistry {
	private readonly defaults: ConfigLayer[] = [];

	registerDefaults(layer: ConfigLayer): void {
		this.defaults.push(layer);
	}

	resolve(layers: Array<ConfigLayer | null | undefined>): CodeliaConfig {
		const merged: CodeliaConfig = { version: CONFIG_VERSION };
		for (const layer of [...this.defaults, ...layers]) {
			if (layer?.model) {
				merged.model = { ...merged.model, ...layer.model };
			}
			if (layer?.permissions) {
				const nextAllow = layer.permissions.allow ?? [];
				const nextDeny = layer.permissions.deny ?? [];
				if (nextAllow.length > 0 || nextDeny.length > 0) {
					merged.permissions ??= {};
					if (nextAllow.length > 0) {
						merged.permissions.allow = [
							...(merged.permissions.allow ?? []),
							...nextAllow,
						];
					}
					if (nextDeny.length > 0) {
						merged.permissions.deny = [
							...(merged.permissions.deny ?? []),
							...nextDeny,
						];
					}
				}
			}
			if (layer?.mcp?.servers) {
				merged.mcp = {
					servers: {
						...(merged.mcp?.servers ?? {}),
						...layer.mcp.servers,
					},
				};
			}
			if (layer?.skills) {
				const nextSkills = layer.skills;
				merged.skills ??= {};
				if (nextSkills.enabled !== undefined) {
					merged.skills.enabled = nextSkills.enabled;
				}
				if (nextSkills.initial) {
					merged.skills.initial = {
						...(merged.skills.initial ?? {}),
						...nextSkills.initial,
					};
				}
				if (nextSkills.search) {
					merged.skills.search = {
						...(merged.skills.search ?? {}),
						...nextSkills.search,
					};
				}
			}
			if (layer?.search) {
				const nextSearch = layer.search;
				merged.search ??= {};
				if (nextSearch.mode !== undefined) {
					merged.search.mode = nextSearch.mode;
				}
				if (nextSearch.native) {
					merged.search.native = {
						...(merged.search.native ?? {}),
						...nextSearch.native,
					};
				}
				if (nextSearch.local) {
					merged.search.local = {
						...(merged.search.local ?? {}),
						...nextSearch.local,
					};
				}
			}
		}
		return merged;
	}
}

export const configRegistry: ConfigRegistry = new ConfigRegistry();
