import { realpath, stat } from "node:fs/promises";
import {
	RPC_ERROR_CODE,
	type SandboxGetResult,
	type SandboxModeChoice,
	type SandboxProjectChangeBlock,
	type SandboxSetErrorData,
} from "@codelia/protocol";
import { ProjectsPolicyStore } from "@codelia/storage";
import { runtimeShellBackend } from "../permissions/runtime-approval";
import type { RuntimeState } from "../runtime-state";
import { parseRequestParams, sendRequestResult } from "./protocol";
import { sendError } from "./transport";

const choices: readonly SandboxModeChoice[] = [
	{
		id: "readonly",
		label: "Read only",
		description:
			"Read permitted local files and write to private scratch space.",
	},
	{
		id: "workspace-write",
		label: "Workspace write",
		description: "Write within the workspace and private scratch space.",
	},
	{
		id: "full-access",
		label: "Full access",
		description:
			"Use the login user's file and network permissions. Command approval still applies.",
	},
];

export const supportsSandboxModeManagement = (state: RuntimeState): boolean => {
	const workspace = state.effectiveEnvironment.workspace;
	return (
		workspace.filesystem === "enabled" ||
		workspace.process === "runtime" ||
		workspace.sandboxMode !== undefined
	);
};

const projectTarget = async (
	state: RuntimeState,
	store: ProjectsPolicyStore,
): Promise<{ workspace: string } | { reason: SandboxProjectChangeBlock }> => {
	if (state.activeRunId) return { reason: "runtime_busy" };
	const { source } = state.sandboxMode;
	if (source === "cli") return { reason: "cli_override" };
	if (source === "env") return { reason: "env_override" };
	if (
		source === "sdk" ||
		state.effectiveEnvironment.sourcePreset !== "tui-local"
	)
		return { reason: "sdk_managed" };
	const root = state.effectiveEnvironment.workspace.root;
	if (!root) return { reason: "workspace_unavailable" };
	if (typeof process.geteuid !== "function")
		return { reason: "policy_acl_unverified" };
	let workspace: string;
	try {
		workspace = await realpath(root);
		if (!(await stat(workspace)).isDirectory())
			return { reason: "workspace_unavailable" };
	} catch {
		return { reason: "workspace_unavailable" };
	}
	try {
		await store.verifyProjectModeWritable(workspace);
	} catch {
		return { reason: "policy_store_unavailable" };
	}
	return { workspace };
};

const modeChoices = (state: RuntimeState): SandboxModeChoice[] => {
	const environment = state.effectiveEnvironment;
	return choices.map((choice) => {
		const allowed =
			environment.sourcePreset !== "tui-local" ||
			((choice.id !== "full-access" || typeof process.geteuid === "function") &&
				(environment.workspace.process !== "runtime" ||
					runtimeShellBackend(environment, choice.id)));
		return allowed
			? choice
			: { ...choice, unavailable_reason: "platform_unavailable" };
	});
};

const status = async (
	state: RuntimeState,
	store: ProjectsPolicyStore,
): Promise<SandboxGetResult> => {
	const target = await projectTarget(state, store);
	return {
		effective: state.sandboxMode,
		applied: state.appliedSandboxMode,
		project:
			"reason" in target
				? { writable: false, reason: target.reason }
				: { writable: true },
		choices: modeChoices(state),
	};
};

export const handleSandbox = async (
	state: RuntimeState,
	id: string,
	method: "sandbox.get" | "sandbox.set",
	params: unknown,
): Promise<void> => {
	if (!supportsSandboxModeManagement(state))
		return sendError(id, {
			code: RPC_ERROR_CODE.METHOD_NOT_FOUND,
			message: "Sandbox management is unavailable.",
		});
	if (method === "sandbox.get") {
		const parsed = parseRequestParams(method, params);
		if (!parsed.ok) return sendError(id, parsed.error);
		const store = new ProjectsPolicyStore();
		return sendRequestResult(
			method,
			id,
			await state.withAdmissionLock(() => status(state, store)),
		);
	}
	const parsed = parseRequestParams(method, params);
	if (!parsed.ok) return sendError(id, parsed.error);
	const { mode } = parsed.params;
	const store = new ProjectsPolicyStore();
	const fail = (reason: SandboxSetErrorData["reason"]) =>
		sendError(id, {
			code:
				reason === "runtime_busy" || reason === "policy_store_busy"
					? RPC_ERROR_CODE.RUNTIME_BUSY
					: RPC_ERROR_CODE.INVALID_PARAMS,
			message: `Project sandbox mode could not be changed (${reason}).`,
			data: { reason } satisfies SandboxSetErrorData,
		});
	if (state.activeRunId) return fail("runtime_busy");
	return state.withAdmissionLock(async () => {
		const target = await projectTarget(state, store);
		if ("reason" in target) return fail(target.reason);
		if (state.sandboxMode.value === mode) return fail("already_effective");
		if (
			modeChoices(state).find((choice) => choice.id === mode)
				?.unavailable_reason
		)
			return fail("platform_unavailable");
		try {
			await store.writeProjectMode(target.workspace, mode);
		} catch (error) {
			return fail(
				(error as NodeJS.ErrnoException).code === "SQLITE_BUSY"
					? "policy_store_busy"
					: "policy_store_unavailable",
			);
		}
		state.sandboxMode = { value: mode, source: "project" };
		state.approvalMode = null;
		state.invalidateAgentCache();
		return sendRequestResult(method, id, await status(state, store));
	});
};
