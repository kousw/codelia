import {
	CONFIG_GROUP_DEFAULT_WRITE_SCOPE,
	type CodeliaConfig,
	type ConfigWriteGroup,
	configRegistry,
	SUBAGENT_MAX_CONCURRENT_LIMIT,
} from "@codelia/config";
import type {
	ConfigEntry,
	ConfigScalar,
	ConfigScope,
	ConfigValueType,
} from "@codelia/protocol";

/**
 * Config keys exposed through `config.get` / `config.set`.
 *
 * Only scalar leaves whose merge rule is "last layer wins" belong here. Keys that
 * run commands, choose endpoints or credentials (`mcp.*`, `providers.*`,
 * `startup_checks.commands`, `*_api_key_env`) and permission rules are
 * intentionally absent. Keys with a validated dedicated RPC are read-only.
 */
export type ConfigKeySpec = {
	key: string;
	type: ConfigValueType;
	enum?: ConfigScalar[];
	min?: number;
	max?: number;
	/** Value runtime uses when no layer sets it (null: no fixed default). */
	fallback: ConfigScalar | null;
	writeVia?: string;
};

const POSITIVE_INT_MAX = 2_147_483_647;

export const CONFIG_KEYS: readonly ConfigKeySpec[] = [
	{
		key: "model.provider",
		type: "string",
		fallback: null,
		writeVia: "model.set",
	},
	{ key: "model.name", type: "string", fallback: null, writeVia: "model.set" },
	{
		key: "model.reasoning",
		type: "string",
		fallback: null,
		writeVia: "model.set",
	},
	{
		key: "model.verbosity",
		type: "string",
		fallback: null,
		writeVia: "model.set",
	},
	{
		key: "model.fast",
		type: "enum",
		enum: [false, true, "ultrafast"],
		fallback: false,
		writeVia: "model.set",
	},
	{ key: "tui.theme", type: "string", fallback: null, writeVia: "theme.set" },
	{
		key: "tui.color_scheme",
		type: "enum",
		enum: ["dark", "light"],
		fallback: "dark",
	},
	{
		key: "tui.image_protocol",
		type: "enum",
		enum: ["halfblocks", "kitty"],
		fallback: "halfblocks",
	},
	{
		key: "auth.oauth_browser",
		type: "enum",
		enum: ["auto", "manual"],
		fallback: null,
	},
	{ key: "agents.enabled", type: "boolean", fallback: true },
	{
		key: "subagent.max_concurrent",
		type: "integer",
		min: 1,
		max: SUBAGENT_MAX_CONCURRENT_LIMIT,
		fallback: 8,
	},
	{ key: "subagent.default_profile", type: "string", fallback: null },
	{
		key: "experimental.openai.websocket_mode",
		type: "enum",
		enum: ["off", "auto", "on"],
		fallback: "off",
	},
	{ key: "skills.enabled", type: "boolean", fallback: true },
	{
		key: "search.mode",
		type: "enum",
		enum: ["auto", "native", "local"],
		fallback: "auto",
	},
	{
		key: "search.native.search_context_size",
		type: "enum",
		enum: ["low", "medium", "high"],
		fallback: null,
	},
	{
		key: "search.local.backend",
		type: "enum",
		enum: ["ddg", "brave"],
		fallback: "ddg",
	},
	{
		key: "execution_environment.startup_checks.enabled",
		type: "boolean",
		fallback: true,
	},
	{
		key: "execution_environment.startup_checks.timeout_ms",
		type: "integer",
		min: 1,
		max: POSITIVE_INT_MAX,
		fallback: 10_000,
	},
];

const SPEC_BY_KEY = new Map(CONFIG_KEYS.map((spec) => [spec.key, spec]));

export const findConfigKey = (key: string): ConfigKeySpec | undefined =>
	SPEC_BY_KEY.get(key);

export const configKeyPath = (spec: ConfigKeySpec): string[] =>
	spec.key.split(".");

const isScalar = (value: unknown): value is ConfigScalar =>
	typeof value === "string" ||
	typeof value === "boolean" ||
	(typeof value === "number" && Number.isFinite(value));

const readPath = (
	config: CodeliaConfig | null | undefined,
	spec: ConfigKeySpec,
): ConfigScalar | undefined => {
	let cursor: unknown = config;
	for (const segment of configKeyPath(spec)) {
		if (typeof cursor !== "object" || cursor === null) return undefined;
		cursor = (cursor as Record<string, unknown>)[segment];
	}
	return isScalar(cursor) ? cursor : undefined;
};

/** Returns an error message, or null when `value` fits the key. */
export const validateConfigValue = (
	spec: ConfigKeySpec,
	value: unknown,
): string | null => {
	switch (spec.type) {
		case "boolean":
			return typeof value === "boolean"
				? null
				: `${spec.key} must be a boolean`;
		case "integer":
			if (
				typeof value !== "number" ||
				!Number.isInteger(value) ||
				(spec.min !== undefined && value < spec.min) ||
				(spec.max !== undefined && value > spec.max)
			) {
				return `${spec.key} must be an integer from ${spec.min ?? "-"} to ${spec.max ?? "-"}`;
			}
			return null;
		case "string":
			return typeof value === "string" && value.trim().length > 0
				? null
				: `${spec.key} must be a non-empty string`;
		case "enum":
			return spec.enum?.some((option) => option === value)
				? null
				: `${spec.key} must be one of ${JSON.stringify(spec.enum)}`;
	}
};

export const buildConfigEntry = (
	spec: ConfigKeySpec,
	layers: {
		globalConfig: CodeliaConfig | null;
		projectConfig: CodeliaConfig | null;
	},
): ConfigEntry => {
	const global = readPath(layers.globalConfig, spec);
	const project = readPath(layers.projectConfig, spec);
	const registryDefault = readPath(configRegistry.resolve([]), spec);
	const value = project ?? global ?? registryDefault ?? spec.fallback;
	const source =
		project !== undefined
			? "project"
			: global !== undefined
				? "global"
				: "default";
	const group = configKeyPath(spec)[0] as ConfigWriteGroup;
	const defaultScope: ConfigScope =
		CONFIG_GROUP_DEFAULT_WRITE_SCOPE[group] ?? "global";
	return {
		key: spec.key,
		value,
		source,
		...(global !== undefined ? { global } : {}),
		...(project !== undefined ? { project } : {}),
		type: spec.type,
		...(spec.enum ? { enum: [...spec.enum] } : {}),
		...(spec.min !== undefined ? { min: spec.min } : {}),
		...(spec.max !== undefined ? { max: spec.max } : {}),
		default_scope: defaultScope,
		writable: spec.writeVia === undefined,
		...(spec.writeVia ? { write_via: spec.writeVia } : {}),
	};
};
