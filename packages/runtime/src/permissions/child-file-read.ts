import { realpathSync } from "node:fs";
import type { RuntimeState } from "../runtime-state";
import type { SubagentFileReadAdmission } from "../subagents/parent-channel";
import { shellPolicySnapshot, shellPolicyVersion } from "./policy-index";
import { runtimeResourcePolicy } from "./runtime-resource-policy";
import { directoryIdentity } from "./shell-backend";
import { matchToolRule } from "./utils";

/** Read authority is sampled in the owning runtime and rechecked before release. */
export const createChildFileReadAdmission = (
	state: RuntimeState,
	readAuthority: (name: "read" | "read_line", target: string) => boolean,
): SubagentFileReadAdmission => {
	const environment = state.effectiveEnvironment;
	return async ({ owner, workspace, operation, rawArgs, signal }) => {
		const root = realpathSync(workspace);
		const rootIdentity = directoryIdentity(root);
		const connection = state.approvalConnectionGeneration;
		const hostRevision = environment.adapters.approvalPolicyRevision?.();
		const policyVersion = shellPolicyVersion(state, root);
		const checkCurrent = () => {
			signal?.throwIfAborted();
			if (
				state.sessionId !== owner ||
				state.effectiveEnvironment !== environment ||
				state.runtimeSandboxRoot !== root ||
				state.approvalConnectionGeneration !== connection ||
				environment.adapters.approvalPolicyRevision?.() !== hostRevision ||
				shellPolicyVersion(state, root) !== policyVersion ||
				realpathSync(root) !== root ||
				directoryIdentity(root) !== rootIdentity
			)
				throw new Error("Delegated file permission expired");
		};
		checkCurrent();
		const [policy, resources] = await Promise.all([
			shellPolicySnapshot(state, root, policyVersion),
			runtimeResourcePolicy(state, root),
		]);
		checkCurrent();
		if (
			policy.deny?.some(
				(rule) =>
					matchToolRule(rule, operation, rawArgs) ||
					matchToolRule(rule, "read", rawArgs),
			)
		)
			throw new Error("Delegated file permission denied");
		const released = new Set<string>();
		const permits = (target: string) => {
			const allowed =
				readAuthority("read", target) &&
				(operation !== "read_line" || readAuthority("read_line", target));
			if (allowed) released.add(target);
			return allowed;
		};
		return {
			permits,
			checkCurrent: () => {
				checkCurrent();
				for (const target of released) {
					if (!permits(target))
						throw new Error("Delegated file permission expired");
				}
			},
			protectedPaths: resources.protectedPaths,
		};
	};
};
