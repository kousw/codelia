import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
	ResolveStorageOptions,
	StorageLayout,
	StoragePaths,
} from "@codelia/core";

const DEFAULT_ROOT_DIR = ".codelia";
const LAYOUT_ENV = "CODELIA_LAYOUT";
const XDG_DIR_NAME = "codelia";
const CONFIG_FILENAME = "config.json";
const AUTH_FILENAME = "auth.json";
const MCP_AUTH_FILENAME = "mcp-auth.json";
const CACHE_DIRNAME = "cache";
const TOOL_OUTPUT_CACHE_DIRNAME = "tool-output";
const SESSIONS_DIRNAME = "sessions";
const LOGS_DIRNAME = "logs";

export function resolveStoragePaths(
	options: ResolveStorageOptions = {},
): StoragePaths {
	if (options.rootOverride) {
		return buildHomeLayout(options.rootOverride);
	}
	const layoutValue = options.layout ?? process.env[LAYOUT_ENV];
	const layout = normalizeLayout(layoutValue);
	if (layout === "xdg") {
		return buildXdgLayout();
	}
	return buildHomeLayout(defaultHomeRoot());
}

export async function ensureStorageDirs(paths: StoragePaths): Promise<void> {
	await Promise.all([
		mkdir(paths.configDir, { recursive: true }),
		mkdir(paths.cacheDir, { recursive: true }),
		mkdir(paths.toolOutputCacheDir, { recursive: true }),
		mkdir(paths.sessionsDir, { recursive: true }),
		mkdir(paths.logsDir, { recursive: true }),
	]);
}

function normalizeLayout(value?: string): StorageLayout {
	if (value && value.toLowerCase() === "xdg") return "xdg";
	return "home";
}

function defaultHomeRoot(): string {
	return path.join(os.homedir(), DEFAULT_ROOT_DIR);
}

function buildHomeLayout(root: string): StoragePaths {
	const configDir = root;
	return {
		root,
		configDir,
		configFile: path.join(configDir, CONFIG_FILENAME),
		authFile: path.join(configDir, AUTH_FILENAME),
		mcpAuthFile: path.join(configDir, MCP_AUTH_FILENAME),
		cacheDir: path.join(root, CACHE_DIRNAME),
		toolOutputCacheDir: path.join(
			root,
			CACHE_DIRNAME,
			TOOL_OUTPUT_CACHE_DIRNAME,
		),
		sessionsDir: path.join(root, SESSIONS_DIRNAME),
		logsDir: path.join(root, LOGS_DIRNAME),
	};
}

function buildXdgLayout(): StoragePaths {
	const home = os.homedir();
	const configRoot = process.env.XDG_CONFIG_HOME ?? path.join(home, ".config");
	const cacheRoot = process.env.XDG_CACHE_HOME ?? path.join(home, ".cache");
	const stateRoot =
		process.env.XDG_STATE_HOME ?? path.join(home, ".local", "state");
	const configDir = path.join(configRoot, XDG_DIR_NAME);
	const cacheDir = path.join(cacheRoot, XDG_DIR_NAME);
	const stateDir = path.join(stateRoot, XDG_DIR_NAME);
	return {
		root: stateDir,
		configDir,
		configFile: path.join(configDir, CONFIG_FILENAME),
		authFile: path.join(configDir, AUTH_FILENAME),
		mcpAuthFile: path.join(configDir, MCP_AUTH_FILENAME),
		cacheDir,
		toolOutputCacheDir: path.join(cacheDir, TOOL_OUTPUT_CACHE_DIRNAME),
		sessionsDir: path.join(stateDir, SESSIONS_DIRNAME),
		logsDir: path.join(stateDir, LOGS_DIRNAME),
	};
}
