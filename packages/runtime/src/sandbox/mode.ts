import { promises as fs } from "node:fs";
import type { SandboxModeInfo } from "@codelia/protocol";
import {
	type ApprovalMode,
	parseApprovalMode,
	parseSandboxMode,
	type SandboxMode,
} from "@codelia/shared-types";
import { ProjectsPolicyStore } from "@codelia/storage";
import type { EffectiveRuntimeEnvironment } from "../environment";

export const defaultSandboxMode: SandboxModeInfo = Object.freeze({
	value: "workspace-write",
	source: "fallback",
});

// A legacy approval preference cannot opt the user out of OS isolation.
const fromLegacy = (legacy: ApprovalMode): SandboxMode =>
	legacy === "minimal" ? "readonly" : "workspace-write";

const readFlag = (
	args: readonly string[],
	flag: string,
): string | undefined => {
	for (const [index, arg] of args.entries()) {
		if (arg === "--") break;
		if (arg === flag) return args[index + 1] ?? "";
		if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
	}
	return undefined;
};

const parseMode = (
	value: string,
	label: string,
	source: "cli" | "env",
	legacy: boolean,
): SandboxModeInfo => {
	const old = legacy ? parseApprovalMode(value.trim()) : undefined;
	if (old) return { value: fromLegacy(old), source, legacy: old };
	const mode = legacy ? undefined : parseSandboxMode(value.trim());
	if (mode) return { value: mode, source };
	const expected = legacy
		? "minimal, trusted, full-access"
		: "readonly, workspace-write, full-access";
	throw new Error(`Invalid ${label} (expected ${expected})`);
};

export const resolveRuntimeSandboxMode = async (
	environment: EffectiveRuntimeEnvironment,
	input: {
		args?: readonly string[];
		env?: NodeJS.ProcessEnv;
		store?: ProjectsPolicyStore;
	} = {},
): Promise<SandboxModeInfo> => {
	const { sandboxMode, root } = environment.workspace;
	if (sandboxMode) return { value: sandboxMode, source: "sdk" };
	if (environment.sourcePreset !== "tui-local" || !root)
		return defaultSandboxMode;

	const args = input.args ?? process.argv.slice(2);
	const env = input.env ?? process.env;
	const modeFlag = readFlag(args, "--sandbox-mode");
	if (modeFlag !== undefined)
		return parseMode(modeFlag, "--sandbox-mode", "cli", false);
	const legacyFlag = readFlag(args, "--approval-mode");
	if (legacyFlag !== undefined)
		return parseMode(legacyFlag, "--approval-mode", "cli", true);
	if (env.CODELIA_SANDBOX_MODE !== undefined)
		return parseMode(
			env.CODELIA_SANDBOX_MODE,
			"CODELIA_SANDBOX_MODE",
			"env",
			false,
		);
	if (env.CODELIA_APPROVAL_MODE !== undefined)
		return parseMode(
			env.CODELIA_APPROVAL_MODE,
			"CODELIA_APPROVAL_MODE",
			"env",
			true,
		);

	const store = input.store ?? new ProjectsPolicyStore();
	const projectKey = await fs
		.realpath(root)
		.catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
			return root;
		});
	const policy = await store.loadUserOwned(projectKey);
	for (const [source, entry] of [
		["project", policy?.projects?.[projectKey]],
		["default", policy?.default],
	] as const) {
		if (entry?.sandbox_mode) return { value: entry.sandbox_mode, source };
		if (entry?.approval_mode)
			return {
				value: fromLegacy(entry.approval_mode),
				source,
				legacy: entry.approval_mode,
			};
	}
	return defaultSandboxMode;
};
