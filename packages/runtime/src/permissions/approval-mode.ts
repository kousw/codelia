import { promises as fs } from "node:fs";
import path from "node:path";
import { type ApprovalMode, parseApprovalMode } from "@codelia/shared-types";
import { type ProjectsPolicyFile, ProjectsPolicyStore } from "@codelia/storage";

const normalizePath = async (value: string): Promise<string> => {
	const absolute = path.resolve(value);
	try {
		return await fs.realpath(absolute);
	} catch {
		return absolute;
	}
};

export const resolveProjectPolicyKey = async (
	workingDir: string,
	runtimeSandboxRoot?: string | null,
): Promise<string> => {
	const basePath = runtimeSandboxRoot ?? workingDir;
	return normalizePath(basePath);
};

const APPROVAL_MODE_HINT = "minimal|trusted|full-access";

const parseApprovalModeOrThrow = (
	raw: string | undefined,
	source: string,
): ApprovalMode => {
	if (!raw || raw.trim().length === 0) {
		throw new Error(
			`Invalid ${source}: missing value (expected ${APPROVAL_MODE_HINT})`,
		);
	}
	const parsed = parseApprovalMode(raw);
	if (!parsed) {
		throw new Error(
			`Invalid ${source}: '${raw}' (expected ${APPROVAL_MODE_HINT})`,
		);
	}
	return parsed;
};

const resolveCliApprovalModeOrThrow = (
	args: string[],
): ApprovalMode | undefined => {
	for (let i = 0; i < args.length; i += 1) {
		const current = args[i];
		if (!current.startsWith("--approval-mode")) continue;
		if (current === "--approval-mode") {
			return parseApprovalModeOrThrow(args[i + 1], "--approval-mode");
		}
		if (current.startsWith("--approval-mode=")) {
			return parseApprovalModeOrThrow(
				current.slice("--approval-mode=".length),
				"--approval-mode",
			);
		}
	}
	return undefined;
};

const resolveEnvApprovalModeOrThrow = (
	env: NodeJS.ProcessEnv,
): ApprovalMode | undefined => {
	if (env.CODELIA_APPROVAL_MODE === undefined) {
		return undefined;
	}
	return parseApprovalModeOrThrow(
		env.CODELIA_APPROVAL_MODE,
		"CODELIA_APPROVAL_MODE",
	);
};

const resolvePolicyApprovalMode = (
	policy: Awaited<ReturnType<ProjectsPolicyStore["load"]>>,
	projectKey: string,
):
	| { approvalMode: ApprovalMode; source: "project" | "default" }
	| undefined => {
	if (!policy) {
		return undefined;
	}
	const projectMode = parseApprovalMode(
		policy.projects?.[projectKey]?.approval_mode,
	);
	if (projectMode) {
		return { approvalMode: projectMode, source: "project" };
	}
	const defaultMode = parseApprovalMode(policy.default?.approval_mode);
	if (defaultMode) {
		return { approvalMode: defaultMode, source: "default" };
	}
	return undefined;
};

const loadProjectsPolicyOrThrow = async (
	store: ProjectsPolicyStore,
): Promise<ProjectsPolicyFile | null> => {
	try {
		return await store.load();
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Failed to load approval mode policy (${store.getFilePath()}): ${detail}`,
		);
	}
};

const persistProjectApprovalModeOrThrow = async (
	store: ProjectsPolicyStore,
	projectKey: string,
	approvalMode: ApprovalMode,
	basePolicy: ProjectsPolicyFile | null,
): Promise<void> => {
	const policy = basePolicy ?? { version: 1 };
	const nextProjects = {
		...(policy.projects ?? {}),
		[projectKey]: {
			approval_mode: approvalMode,
		},
	};
	await store.save({
		...policy,
		version: 1,
		projects: nextProjects,
	});
};

/**
 * CLI flag / `CODELIA_APPROVAL_MODE`, which take precedence over the policy
 * store. Throws on an invalid value (no silent fallthrough).
 */
export const resolveApprovalModeOverride = ():
	| { approvalMode: ApprovalMode; source: "cli" | "env" }
	| undefined => {
	const cliMode = resolveCliApprovalModeOrThrow(process.argv.slice(2));
	if (cliMode) return { approvalMode: cliMode, source: "cli" };
	const envMode = resolveEnvApprovalModeOrThrow(process.env);
	if (envMode) return { approvalMode: envMode, source: "env" };
	return undefined;
};

export type ApprovalModePolicyScope = "project" | "default";

/** The existing policy store could not be read; nothing was written. */
export class ApprovalModePolicyUnreadableError extends Error {}

/**
 * Sets one entry of the policy store. An unreadable store throws instead of
 * being overwritten. Returns whether the file was written.
 */
export const writeApprovalModePolicy = async (
	{
		scope,
		projectKey,
		approvalMode,
	}: {
		scope: ApprovalModePolicyScope;
		projectKey: string;
		approvalMode: ApprovalMode;
	},
	deps: ResolveApprovalModeDeps = {},
): Promise<{ changed: boolean; path: string }> => {
	const store = deps.store ?? new ProjectsPolicyStore();
	let policy: ProjectsPolicyFile;
	try {
		policy = (await loadProjectsPolicyOrThrow(store)) ?? { version: 1 };
	} catch (error) {
		throw new ApprovalModePolicyUnreadableError(
			error instanceof Error ? error.message : String(error),
		);
	}
	const current =
		scope === "project"
			? policy.projects?.[projectKey]?.approval_mode
			: policy.default?.approval_mode;
	if (current === approvalMode) {
		return { changed: false, path: store.getFilePath() };
	}
	if (scope === "project") {
		await persistProjectApprovalModeOrThrow(
			store,
			projectKey,
			approvalMode,
			policy,
		);
	} else {
		await store.save({
			...policy,
			version: 1,
			default: { ...(policy.default ?? {}), approval_mode: approvalMode },
		});
	}
	return { changed: true, path: store.getFilePath() };
};

export type ApprovalModeResolutionSource =
	| "cli"
	| "env"
	| "project"
	| "default"
	| "startup-selection"
	| "fallback";

export type ResolveApprovalModeDeps = {
	store?: ProjectsPolicyStore;
};

export type ResolveApprovalModeOptions = {
	workingDir: string;
	runtimeSandboxRoot?: string | null;
	requestStartupSelection?: (input: {
		projectKey: string;
	}) => Promise<ApprovalMode | null>;
	deferStartupSelectionPersist?: boolean;
};

export const resolveApprovalModeForRuntime = async (
	options: ResolveApprovalModeOptions,
	deps: ResolveApprovalModeDeps = {},
): Promise<{
	approvalMode: ApprovalMode;
	source: ApprovalModeResolutionSource;
	projectKey: string;
	persistSelection?: () => Promise<void>;
}> => {
	const projectKey = await resolveProjectPolicyKey(
		options.workingDir,
		options.runtimeSandboxRoot,
	);

	const override = resolveApprovalModeOverride();
	if (override) {
		return { ...override, projectKey };
	}

	const store = deps.store ?? new ProjectsPolicyStore();
	const loadedPolicy = await loadProjectsPolicyOrThrow(store);
	const policyMode = resolvePolicyApprovalMode(loadedPolicy, projectKey);
	if (policyMode) {
		return {
			approvalMode: policyMode.approvalMode,
			source: policyMode.source,
			projectKey,
		};
	}

	if (options.requestStartupSelection) {
		const selected = await options.requestStartupSelection({ projectKey });
		if (selected) {
			const persistSelection = async (): Promise<void> => {
				await persistProjectApprovalModeOrThrow(
					store,
					projectKey,
					selected,
					loadedPolicy,
				);
			};
			if (!options.deferStartupSelectionPersist) {
				await persistSelection();
			}
			return {
				approvalMode: selected,
				source: "startup-selection",
				projectKey,
				...(options.deferStartupSelectionPersist ? { persistSelection } : {}),
			};
		}
	}

	return { approvalMode: "minimal", source: "fallback", projectKey };
};
