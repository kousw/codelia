import { RPC_ERROR_CODE, type WorktreeCreateParams } from "@codelia/protocol";
import { z } from "zod";
import type { RuntimeState } from "../runtime-state";
import { WorktreeService } from "../worktrees/service";
import { sendError, sendResult } from "./transport";
import { requestUiConfirm } from "./ui-requests";

const createParams = z
	.object({
		operation_id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
		title: z.string().min(1).max(80),
		base_ref: z.string().min(1).max(256).optional(),
		thread_id: z.string().min(1).max(256),
		run_id: z.string().min(1).max(256).optional(),
	})
	.strict();

export const createWorktreeHandlers = (
	state: RuntimeState,
	service = new WorktreeService(
		state.effectiveEnvironment.workspace.root ??
			state.runtimeWorkingDir ??
			process.cwd(),
	),
) => {
	return {
		async list(id: string, params: unknown): Promise<void> {
			if (
				!z
					.object({})
					.strict()
					.safeParse(params ?? {}).success
			) {
				sendError(id, {
					code: RPC_ERROR_CODE.INVALID_PARAMS,
					message: "worktree.list accepts no parameters",
				});
				return;
			}
			try {
				sendResult(id, await service.list());
			} catch {
				sendError(id, {
					code: RPC_ERROR_CODE.RUNTIME_INTERNAL,
					message: "Worktree list unavailable; open an existing Git checkout",
				});
			}
		},
		async create(id: string, params: unknown): Promise<void> {
			const parsed = createParams.safeParse(params);
			if (!parsed.success || !state.uiCapabilities?.supports_confirm) {
				sendError(id, {
					code: RPC_ERROR_CODE.INVALID_PARAMS,
					message: "Valid worktree parameters and UI confirmation are required",
				});
				return;
			}
			const input: WorktreeCreateParams = parsed.data;
			const signal = input.run_id ? state.activeRunSignal : undefined;
			if (
				input.run_id &&
				(input.run_id !== state.activeRunId ||
					state.cancelRequested ||
					signal?.aborted)
			) {
				sendError(id, {
					code: RPC_ERROR_CODE.INVALID_PARAMS,
					message: "Worktree request belongs to an inactive parent run",
				});
				return;
			}
			try {
				const result = await service.create(input, async (operation) => {
					const answer = await requestUiConfirm(
						state,
						{
							...(input.run_id ? { run_id: input.run_id } : {}),
							title: "Create worktree",
							message: `Thread: ${operation.thread_id}\nSource: ${operation.source_path}\nCommitted base: ${operation.base_ref} (${operation.base_commit})\nBranch: ${operation.branch}\nDestination: ${operation.path}\n\nSource uncommitted changes stay in place. No agent or setup script starts.`,
							confirm_label: "Create",
							cancel_label: "Cancel",
							allow_remember: false,
							worktree: {
								actor: input.run_id ? "parent_agent" : "user",
								operation_id: operation.operation_id,
								thread_id: operation.thread_id,
								source_path: operation.source_path,
								base_commit: operation.base_commit,
								branch: operation.branch,
								path: operation.path,
							},
						},
						signal,
					);
					// A normally completed parent does not revoke an already admitted
					// exact intent. Its captured Stop signal still cancels the wait;
					// another run's cancellation must never invalidate this operation.
					return answer?.ok === true && !signal?.aborted;
				});
				sendResult(id, result);
			} catch (error) {
				// Git failures can contain config-derived prose; do not relay raw process output.
				const message =
					error instanceof Error && !error.message.startsWith("git ")
						? error.message
						: "Worktree creation could not be prepared";
				sendError(id, { code: RPC_ERROR_CODE.INVALID_PARAMS, message });
			}
		},
	};
};
