/** Config file layer. `project` is `<workspace>/.codelia/config.json`. */
export type ConfigScope = "global" | "project";

/** Where an effective value came from. */
export type ConfigValueSource = "default" | ConfigScope;

export type ConfigValueType = "boolean" | "integer" | "string" | "enum";

export type ConfigScalar = string | number | boolean;

export type ConfigEntry = {
	/** Dotted key, e.g. `search.mode`. Only registry keys are exposed. */
	key: string;
	/** Effective value; null when unset and runtime has no fixed default. */
	value: ConfigScalar | null;
	source: ConfigValueSource;
	/** Value in the global file, when set there. */
	global?: ConfigScalar;
	/** Value in the project file, when set there. */
	project?: ConfigScalar;
	type: ConfigValueType;
	enum?: ConfigScalar[];
	min?: number;
	max?: number;
	/** Scope runtime writes the group to when a client has no preference. */
	default_scope: ConfigScope;
	/** False: read-only here; change it through `write_via`. */
	writable: boolean;
	write_via?: string;
};

export type ConfigGetParams = {
	/** Omitted returns every registry key. */
	keys?: string[];
};

export type ConfigGetResult = {
	paths: { global: string; project: string | null };
	entries: ConfigEntry[];
	/** Unreadable layers (treated as empty); messages contain no file contents. */
	errors?: Array<{ scope: ConfigScope; message: string }>;
};

export type ConfigSetParams = {
	scope: ConfigScope;
	key: string;
	/** Required unless `unset` is true. */
	value?: ConfigScalar;
	/** Remove the key from that file (empty parent objects are pruned). */
	unset?: boolean;
};

export type ConfigSetResult = {
	key: string;
	scope: ConfigScope;
	path: string;
	entry: ConfigEntry;
	/** When the change takes effect: the next `run.start` rebuilds the agent. */
	applies: "next_run";
};
