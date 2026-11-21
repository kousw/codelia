import { statSync } from "node:fs";
import type { PermissionRule } from "@codelia/config";
import { resolveConfigPath, resolveProjectConfigPath } from "../config";
import { resolveEnvironmentPermissionsConfig } from "../environment-services";
import {
	localPermissionAllowRevision,
	resolveLocalPermissionAllows,
} from "../local-permission-allows";
import type { ApprovalScope, RuntimeState } from "../runtime-state";

type ShellPolicySnapshot = Readonly<{
	version: string;
	allow: readonly PermissionRule[];
	deny?: readonly PermissionRule[];
}>;

const snapshots = new WeakMap<
	RuntimeState,
	{
		version: string;
		value: Promise<ShellPolicySnapshot>;
	}
>();

const stamp = (file: string): string => {
	try {
		const info = statSync(file, { bigint: true });
		return `${file}:${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return `${file}:missing`;
		throw error;
	}
};

export const shellPolicyVersion = (
	state: RuntimeState,
	root: string,
	scope: ApprovalScope = "session",
): string => {
	const { config, adapters } = state.effectiveEnvironment;
	const generation = state.approvalAuthorityRevision(scope);
	if (config.source === "host")
		return JSON.stringify([
			root,
			generation,
			adapters.approvalPolicyRevision?.(),
		]);
	if (config.source === "disabled") return JSON.stringify([root, generation]);
	return JSON.stringify([
		root,
		generation,
		stamp(resolveConfigPath()),
		stamp(resolveProjectConfigPath(root)),
		localPermissionAllowRevision(state, root),
	]);
};

export const shellPolicySnapshot = (
	state: RuntimeState,
	root: string,
	version: string,
): Promise<ShellPolicySnapshot> => {
	const previous = snapshots.get(state);
	if (previous?.version === version) return previous.value;
	const value = Promise.all([
		resolveEnvironmentPermissionsConfig(state, root),
		resolveLocalPermissionAllows(state, root),
	]).then(([permissions, allow]) =>
		Object.freeze({
			version,
			allow: Object.freeze(allow),
			deny: permissions?.deny
				? Object.freeze(
						permissions.deny.map((rule) => Object.freeze({ ...rule })),
					)
				: undefined,
		}),
	);
	snapshots.set(state, { version, value });
	return value;
};
