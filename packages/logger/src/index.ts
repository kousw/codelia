export type DebugTopic =
	| "debug"
	| "rpc"
	| "ws"
	| "perf"
	| "keys"
	| "diff"
	| "diagnostics"
	| "provider-log"
	| "session-dump"
	| "ansi-syntax";

export type DebugConfig = Readonly<{
	debug: boolean;
	rpc: boolean;
	ws: boolean;
	perf: boolean;
	keys: boolean;
	diff: boolean;
	diagnostics: boolean;
	providerLog: boolean;
	sessionDump: boolean;
	ansiSyntax: boolean;
	dir?: string;
}>;

const EMPTY_DEBUG_CONFIG: DebugConfig = Object.freeze({
	debug: false,
	rpc: false,
	ws: false,
	perf: false,
	keys: false,
	diff: false,
	diagnostics: false,
	providerLog: false,
	sessionDump: false,
	ansiSyntax: false,
});

const OFF_VALUES = new Set(["0", "false", "off", "no"]);
const GENERAL_DEBUG_VALUES = new Set(["1", "true", "on", "yes", "debug"]);
const ALL_SAFE_VALUES = new Set(["*", "all"]);

export const parseDebugConfig = (
	rawDebug?: string,
	rawDir?: string,
): DebugConfig => {
	const dir = rawDir?.trim() || undefined;
	const trimmed = rawDebug?.trim();
	if (!trimmed) {
		return dir
			? Object.freeze({ ...EMPTY_DEBUG_CONFIG, dir })
			: EMPTY_DEBUG_CONFIG;
	}
	const lower = trimmed.toLowerCase();
	if (OFF_VALUES.has(lower)) {
		return dir
			? Object.freeze({ ...EMPTY_DEBUG_CONFIG, dir })
			: EMPTY_DEBUG_CONFIG;
	}

	let debug = false;
	let rpc = false;
	let ws = false;
	let perf = false;
	let keys = false;
	let diff = false;
	let diagnostics = false;
	let providerLog = false;
	let sessionDump = false;
	let ansiSyntax = false;

	for (const part of lower.split(",")) {
		const token = part.trim();
		if (!token || OFF_VALUES.has(token)) continue;
		if (GENERAL_DEBUG_VALUES.has(token)) {
			debug = true;
			rpc = true;
			ws = true;
			continue;
		}
		if (ALL_SAFE_VALUES.has(token)) {
			// Deliberately excludes disk dumps (`provider-log`, `session-dump`) unless explicitly named.
			debug = true;
			rpc = true;
			ws = true;
			perf = true;
			keys = true;
			diff = true;
			diagnostics = true;
			continue;
		}
		switch (token) {
			case "rpc":
				rpc = true;
				debug = true;
				break;
			case "ws":
				ws = true;
				debug = true;
				break;
			case "perf":
				perf = true;
				break;
			case "keys":
			case "key":
				keys = true;
				break;
			case "diff":
			case "diff-highlight":
				diff = true;
				break;
			case "diagnostics":
			case "diag":
				diagnostics = true;
				break;
			case "provider-log":
			case "provider_log":
				providerLog = true;
				break;
			case "session-dump":
			case "session_dump":
				sessionDump = true;
				break;
			case "ansi-syntax":
			case "ansi_syntax":
				ansiSyntax = true;
				break;
			default:
				break;
		}
	}

	return Object.freeze({
		debug,
		rpc,
		ws,
		perf,
		keys,
		diff,
		diagnostics,
		providerLog,
		sessionDump,
		ansiSyntax,
		...(dir ? { dir } : {}),
	});
};

let cachedRawDebug: string | undefined;
let cachedRawDir: string | undefined;
let cachedConfig: DebugConfig = EMPTY_DEBUG_CONFIG;
let cacheInitialized = false;

export const getDebugConfig = (
	env: NodeJS.ProcessEnv = process.env,
): DebugConfig => {
	const rawDebug = env.CODELIA_DEBUG;
	const rawDir = env.CODELIA_DEBUG_DIR;
	if (env === process.env) {
		if (
			cacheInitialized &&
			rawDebug === cachedRawDebug &&
			rawDir === cachedRawDir
		) {
			return cachedConfig;
		}
		cachedRawDebug = rawDebug;
		cachedRawDir = rawDir;
		cachedConfig = parseDebugConfig(rawDebug, rawDir);
		cacheInitialized = true;
		return cachedConfig;
	}
	return parseDebugConfig(rawDebug, rawDir);
};

export const hasDebugTopic = (
	topic: DebugTopic,
	env: NodeJS.ProcessEnv = process.env,
): boolean => {
	const config = getDebugConfig(env);
	switch (topic) {
		case "debug":
			return config.debug;
		case "rpc":
			return config.rpc;
		case "ws":
			return config.ws;
		case "perf":
			return config.perf;
		case "keys":
			return config.keys;
		case "diff":
			return config.diff;
		case "diagnostics":
			return config.diagnostics;
		case "provider-log":
			return config.providerLog;
		case "session-dump":
			return config.sessionDump;
		case "ansi-syntax":
			return config.ansiSyntax;
	}
};

export const getDebugDir = (
	env: NodeJS.ProcessEnv = process.env,
): string | undefined => getDebugConfig(env).dir;

export const isDebugEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
	getDebugConfig(env).debug;

export const log = (message: string): void => {
	process.stderr.write(`[runtime] ${message}\n`);
};

export const debugLog = (message: string): void => {
	if (!isDebugEnabled()) return;
	log(message);
};
