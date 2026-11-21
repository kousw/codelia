import path from "node:path";
import { ProjectsPolicyStore } from "@codelia/storage";
import type { RuntimeState } from "../runtime-state";
import { SandboxContext } from "../sandbox/context";
import { resolvePolicyPath } from "./shell-backend";

type RuntimeResourcePolicy = Readonly<{
	protectedPaths: readonly string[];
	hostProtectedPaths: readonly string[];
	readOnlyPaths: readonly string[];
}>;

const snapshots = new WeakMap<
	RuntimeState,
	{
		environment: RuntimeState["effectiveEnvironment"];
		workspace: string;
		policy: Promise<RuntimeResourcePolicy>;
	}
>();

/** Use the owning runtime's user policy for shell and delegated tools alike. */
export const runtimeResourcePolicy = (
	state: RuntimeState,
	root: string,
): Promise<RuntimeResourcePolicy> => {
	const workspace = resolvePolicyPath(root);
	const environment = state.effectiveEnvironment;
	const previous = snapshots.get(state);
	if (previous?.environment === environment && previous.workspace === workspace)
		return previous.policy;
	const policy = (async () => {
		const local =
			environment.sourcePreset === "tui-local"
				? await new ProjectsPolicyStore().loadUserOwned(workspace, {
						strict: true,
					})
				: null;
		const { approvalProtectedPaths, approvalLaunchRuleStore } =
			environment.adapters;
		const hostProtectedPaths = Object.freeze([
			...new Set(
				(approvalProtectedPaths ?? []).map((entry) => path.resolve(entry)),
			),
		]);
		return Object.freeze({
			hostProtectedPaths,
			protectedPaths: Object.freeze([
				...new Set(
					[
						...(local?.default?.protected_paths ?? []),
						...(local?.projects?.[workspace]?.protected_paths ?? []),
						...hostProtectedPaths,
					].map((entry) => path.resolve(entry)),
				),
			]),
			readOnlyPaths: Object.freeze(
				approvalLaunchRuleStore ? [approvalLaunchRuleStore.directory] : [],
			),
		});
	})();
	snapshots.set(state, { environment, workspace, policy });
	return policy;
};

export type ResourceReader = {
	allows: (target: string) => boolean;
	readText: (target: string) => Promise<string>;
};

export const runtimeResourceReader = async (
	state: RuntimeState,
	workingDir: string,
	context?: SandboxContext | null,
): Promise<ResourceReader> => {
	const root =
		state.runtimeSandboxRoot ??
		state.effectiveEnvironment.workspace.root ??
		workingDir;
	const sandbox = context ?? (await createReadSandbox(state, root));
	return {
		allows: (target) => {
			try {
				sandbox.resolvePath(target, "read");
				return true;
			} catch {
				return false;
			}
		},
		readText: async (target) =>
			(await sandbox.readSelectedFile(target)).toString("utf8"),
	};
};

const createReadSandbox = async (
	state: RuntimeState,
	root: string,
): Promise<SandboxContext> => {
	const policy = await runtimeResourcePolicy(state, root);
	return SandboxContext.create(root, {
		sandboxMode: "readonly",
		protectResources: true,
		extraProtectedPaths: policy.protectedPaths,
		extraReadOnlyPaths: policy.readOnlyPaths,
	});
};
