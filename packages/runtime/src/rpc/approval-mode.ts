import {
	type ApprovalModeSetParams,
	type ApprovalModeSetResult,
	RPC_ERROR_CODE,
} from "@codelia/protocol";
import { parseApprovalMode } from "@codelia/shared-types";
import { isLocalRuntimeEnabled } from "../environment";
import {
	ApprovalModePolicyUnreadableError,
	resolveApprovalModeForRuntime,
	resolveApprovalModeOverride,
	resolveProjectPolicyKey,
	writeApprovalModePolicy,
} from "../permissions/approval-mode";
import type { RuntimeState } from "../runtime-state";
import { resolveConfigWorkspaceDir, supportsConfigReadWrite } from "./config";
import { sendError, sendResult } from "./transport";

/**
 * Runtime-owned config, and an agent that actually resolves its approval mode
 * from the policy store (non-local hosts always run `minimal`).
 */
export const supportsApprovalModeSet = (state: RuntimeState): boolean =>
	supportsConfigReadWrite(state) &&
	isLocalRuntimeEnabled(state.effectiveEnvironment);

const OVERRIDE_LABEL = {
	cli: "--approval-mode",
	env: "CODELIA_APPROVAL_MODE",
} as const;

export const createApprovalModeHandlers = ({
	state,
	log,
}: {
	state: RuntimeState;
	log: (message: string) => void;
}) => {
	const handleApprovalModeSet = async (
		id: string,
		params: ApprovalModeSetParams | undefined,
	): Promise<void> => {
		const invalid = (message: string, data?: unknown) =>
			sendError(id, {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message,
				...(data !== undefined ? { data } : {}),
			});
		if (!supportsApprovalModeSet(state)) {
			invalid("approval mode is not configurable for this runtime");
			return;
		}
		const scope = params?.scope;
		if (scope !== "project" && scope !== "default") {
			invalid("scope must be project or default");
			return;
		}
		const value =
			typeof params?.value === "string"
				? parseApprovalMode(params.value)
				: undefined;
		if (!value) {
			invalid("value must be minimal, trusted or full-access");
			return;
		}
		if (state.activeRunId) {
			sendError(id, {
				code: RPC_ERROR_CODE.RUNTIME_BUSY,
				message: "runtime busy",
			});
			return;
		}
		// A higher-priority source decides the mode for this runtime process, so a
		// store write could not take effect: refuse instead of pretending it applied.
		let override: ReturnType<typeof resolveApprovalModeOverride>;
		try {
			override = resolveApprovalModeOverride();
		} catch {
			invalid("approval mode override (--approval-mode or env) is invalid");
			return;
		}
		if (override) {
			invalid(
				`approval mode is fixed by ${OVERRIDE_LABEL[override.source]} for this runtime`,
				{ source: override.source, value: override.approvalMode },
			);
			return;
		}

		// Same root the agent factory resolves the project key from.
		const sandboxRoot = resolveConfigWorkspaceDir(state) ?? process.cwd();
		type Outcome =
			| "busy"
			| { changed: boolean; path: string }
			| { failed: "load" | "write" };
		let outcome: Outcome;
		try {
			// Recheck idleness under the admission lock so no run starts mid-write.
			outcome = await state.withAdmissionLock(async (): Promise<Outcome> => {
				if (state.activeRunId) return "busy";
				const projectKey = await resolveProjectPolicyKey(
					sandboxRoot,
					sandboxRoot,
				);
				let written: { changed: boolean; path: string };
				try {
					written = await writeApprovalModePolicy({
						scope,
						projectKey,
						approvalMode: value,
					});
				} catch (error) {
					return {
						failed:
							error instanceof ApprovalModePolicyUnreadableError
								? "load"
								: "write",
					};
				}
				// The mode is baked into the sandbox context and PermissionService.
				if (written.changed) state.requestAgentInvalidation();
				return written;
			});
		} catch {
			outcome = { failed: "write" };
		}
		if (outcome === "busy") {
			sendError(id, {
				code: RPC_ERROR_CODE.RUNTIME_BUSY,
				message: "runtime busy",
			});
			return;
		}
		if ("failed" in outcome) {
			sendError(id, {
				code: RPC_ERROR_CODE.RUNTIME_INTERNAL,
				message:
					outcome.failed === "load"
						? "approval mode policy could not be parsed; nothing was written"
						: "approval mode policy write failed",
			});
			return;
		}
		let resolved: Awaited<ReturnType<typeof resolveApprovalModeForRuntime>>;
		try {
			// No startup selection: never prompts or persists.
			resolved = await resolveApprovalModeForRuntime({
				workingDir: sandboxRoot,
				runtimeSandboxRoot: sandboxRoot,
			});
		} catch {
			sendError(id, {
				code: RPC_ERROR_CODE.RUNTIME_INTERNAL,
				message: "approval mode could not be resolved after the write",
			});
			return;
		}
		const result: ApprovalModeSetResult = {
			scope,
			value,
			path: outcome.path,
			changed: outcome.changed,
			approval_mode: { value: resolved.approvalMode, source: resolved.source },
			applies: "next_run",
		};
		sendResult(id, result);
		log(
			`approval_mode.set scope=${scope} value=${value} changed=${outcome.changed} resolved=${resolved.approvalMode}/${resolved.source}`,
		);
	};

	return { handleApprovalModeSet };
};
