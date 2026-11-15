import type { CodeliaConfig } from "@codelia/config";
import { loadConfig, updateConfigValue } from "@codelia/config-loader";
import {
	type ConfigGetParams,
	type ConfigGetResult,
	type ConfigScope,
	type ConfigSetParams,
	type ConfigSetResult,
	RPC_ERROR_CODE,
} from "@codelia/protocol";
import { resolveConfigPath, resolveProjectConfigPath } from "../config";
import {
	buildConfigEntry,
	CONFIG_KEYS,
	configKeyPath,
	findConfigKey,
	validateConfigValue,
} from "../config-keys";
import type { RuntimeState } from "../runtime-state";
import { sendError, sendResult } from "./transport";

const MAX_KEYS_PER_REQUEST = 256;

/** Directory whose `.codelia/config.json` the agent reads (same root as agent-factory). */
export const resolveConfigWorkspaceDir = (state: RuntimeState): string | null =>
	state.effectiveEnvironment.workspace.root ??
	state.runtimeSandboxRoot ??
	state.runtimeWorkingDir ??
	null;

/** File-backed config is readable/writable only for runtime-owned config. */
export const supportsConfigReadWrite = (state: RuntimeState): boolean =>
	state.effectiveEnvironment.config.source === "runtime-default";

type Layers = {
	globalConfig: CodeliaConfig | null;
	projectConfig: CodeliaConfig | null;
	errors: Array<{ scope: ConfigScope; message: string }>;
	paths: { global: string; project: string | null };
};

const loadLayers = async (state: RuntimeState): Promise<Layers> => {
	const workspaceDir = resolveConfigWorkspaceDir(state);
	const paths = {
		global: resolveConfigPath(),
		project: workspaceDir ? resolveProjectConfigPath(workspaceDir) : null,
	};
	const errors: Layers["errors"] = [];
	// A broken layer is reported and treated as empty; its text is not echoed.
	const load = async (scope: ConfigScope, path: string | null) => {
		if (!path) return null;
		try {
			return await loadConfig(path);
		} catch {
			errors.push({ scope, message: `${scope} config could not be parsed` });
			return null;
		}
	};
	const [globalConfig, projectConfig] = await Promise.all([
		load("global", paths.global),
		load("project", paths.project),
	]);
	return { globalConfig, projectConfig, errors, paths };
};

export const createConfigHandlers = ({
	state,
	log,
}: {
	state: RuntimeState;
	log: (message: string) => void;
}) => {
	const rejectUnsupported = (id: string): boolean => {
		if (supportsConfigReadWrite(state)) return false;
		sendError(id, {
			code: RPC_ERROR_CODE.INVALID_PARAMS,
			message: "config read/write is not available for this runtime",
		});
		return true;
	};

	const handleConfigGet = async (
		id: string,
		params: ConfigGetParams | undefined,
	): Promise<void> => {
		if (rejectUnsupported(id)) return;
		const keys = params?.keys;
		if (
			keys !== undefined &&
			(!Array.isArray(keys) ||
				keys.length > MAX_KEYS_PER_REQUEST ||
				keys.some((key) => typeof key !== "string" || !findConfigKey(key)))
		) {
			sendError(id, {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: "keys must list known config keys",
			});
			return;
		}
		const layers = await loadLayers(state);
		const specs = keys
			? CONFIG_KEYS.filter((spec) => keys.includes(spec.key))
			: CONFIG_KEYS;
		const result: ConfigGetResult = {
			paths: layers.paths,
			entries: specs.map((spec) => buildConfigEntry(spec, layers)),
			...(layers.errors.length ? { errors: layers.errors } : {}),
		};
		sendResult(id, result);
	};

	const handleConfigSet = async (
		id: string,
		params: ConfigSetParams | undefined,
	): Promise<void> => {
		if (rejectUnsupported(id)) return;
		if (state.activeRunId) {
			sendError(id, {
				code: RPC_ERROR_CODE.RUNTIME_BUSY,
				message: "runtime busy",
			});
			return;
		}
		const invalid = (message: string) =>
			sendError(id, { code: RPC_ERROR_CODE.INVALID_PARAMS, message });
		const scope = params?.scope;
		if (scope !== "global" && scope !== "project") {
			invalid("scope must be global or project");
			return;
		}
		const spec =
			typeof params?.key === "string" ? findConfigKey(params.key) : undefined;
		if (!spec) {
			invalid("unknown config key");
			return;
		}
		if (spec.writeVia) {
			invalid(`${spec.key} is read-only here; use ${spec.writeVia}`);
			return;
		}
		const unset = params?.unset === true;
		if (params?.unset !== undefined && typeof params.unset !== "boolean") {
			invalid("unset must be a boolean");
			return;
		}
		if (unset && params?.value !== undefined) {
			invalid("value and unset are mutually exclusive");
			return;
		}
		if (!unset) {
			const problem = validateConfigValue(spec, params?.value);
			if (problem) {
				invalid(problem);
				return;
			}
		}
		const workspaceDir = resolveConfigWorkspaceDir(state);
		const path =
			scope === "global"
				? resolveConfigPath()
				: workspaceDir
					? resolveProjectConfigPath(workspaceDir)
					: null;
		if (!path) {
			invalid("project scope requires a workspace directory");
			return;
		}
		let changed: boolean | "busy";
		try {
			// Recheck idleness under the admission lock so no run starts mid-write.
			changed = await state.withAdmissionLock(async () => {
				if (state.activeRunId) return "busy" as const;
				const written = await updateConfigValue(
					path,
					configKeyPath(spec),
					unset ? undefined : params?.value,
				);
				// The cached agent snapshots config at build time; rebuild on the next run.
				if (written) state.invalidateAgentCache();
				return written;
			});
		} catch {
			sendError(id, {
				code: RPC_ERROR_CODE.RUNTIME_INTERNAL,
				message: `${scope} config write failed`,
			});
			return;
		}
		if (changed === "busy") {
			sendError(id, {
				code: RPC_ERROR_CODE.RUNTIME_BUSY,
				message: "runtime busy",
			});
			return;
		}
		const layers = await loadLayers(state);
		const result: ConfigSetResult = {
			key: spec.key,
			scope,
			path,
			entry: buildConfigEntry(spec, layers),
			applies: "next_run",
		};
		sendResult(id, result);
		log(
			`config.set ${spec.key} scope=${scope} ${unset ? "unset" : "set"} changed=${changed}`,
		);
	};

	return { handleConfigGet, handleConfigSet };
};
