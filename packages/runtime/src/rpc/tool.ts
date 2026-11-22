import { createHash } from "node:crypto";
import {
	type Agent,
	type DependencyKey,
	type Tool,
	type ToolContext,
	ToolPermissionDenied,
} from "@codelia/core";
import {
	RPC_ERROR_CODE,
	type ToolCallParams,
	type ToolCallResult,
} from "@codelia/protocol";
import { setOperatorContext } from "../permissions/operator-context";
import {
	ApprovalRequestReceipts,
	assertReceiptScopeCurrent,
} from "../permissions/request-receipts";
import {
	createRuntimeToolApproval,
	isSecuredRuntimeTool,
} from "../permissions/tool-approval";
import type { RuntimeState } from "../runtime-state";
import { sendRequestResult } from "./protocol";
import { sendError } from "./transport";

const normalizeToolResult = (
	result: Awaited<ReturnType<Tool["executeRaw"]>>,
): unknown => {
	switch (result.type) {
		case "json":
			return result.value;
		case "text":
			return result.text;
		case "parts":
			return result.parts;
	}
};

export const createToolContext = (): ToolContext => {
	const deps: Record<string, unknown> = Object.create(null);
	const cache = new Map<string, unknown>();
	const resolve = async <T>(key: DependencyKey<T>): Promise<T> => {
		if (cache.has(key.id)) {
			return cache.get(key.id) as T;
		}
		const value = await key.create();
		cache.set(key.id, value);
		return value;
	};
	return {
		deps,
		resolve,
		now: () => new Date(),
	};
};

export const createToolHandlers = ({
	state,
	getAgent,
}: {
	state: RuntimeState;
	getAgent: () => Promise<Agent>;
}) => {
	// This receipt covers the operator RPC's tool result. The dispatcher
	// independently tracks launch admissions for shell and task RPCs.
	const receipts = new ApprovalRequestReceipts<ToolCallResult>();
	const handleToolCall = async (
		id: string,
		params: ToolCallParams | undefined,
	): Promise<void> => {
		const toolName = params?.name;
		if (!toolName) {
			sendError(id, {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: "tool name is required",
			});
			return;
		}

		if (toolName === "attachment_read" && state.attachments) {
			sendError(id, {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: "attachment_read is only available during a model run",
			});
			return;
		}
		const scope = state.approvalReceiptScope();
		const version = state.approvalContext();
		try {
			if (!state.tools) {
				await state.withAdmissionLock(getAgent);
			}
			assertReceiptScopeCurrent(scope);
			if (state.approvalContext() !== version)
				throw new Error("approval_expired");
			const tool = state.tools?.find((entry) => entry.name === toolName);
			if (!tool) {
				sendError(id, {
					code: RPC_ERROR_CODE.INVALID_PARAMS,
					message: `unknown tool: ${toolName}`,
				});
				return;
			}
			const raw = JSON.stringify(params?.arguments ?? {});
			const digest = createHash("sha256")
				.update(JSON.stringify([version, toolName, raw]))
				.digest("hex");
			const result = await receipts.run(scope, id, digest, async () => {
				const context = {
					...createToolContext(),
					signal: state.activeRunSignal,
				};
				context.signal?.throwIfAborted();
				if (state.approvalContext() !== version || !state.tools?.includes(tool))
					throw new Error("approval_expired");
				setOperatorContext(context, id);
				const managed = isSecuredRuntimeTool(tool)
					? tool
					: createRuntimeToolApproval({
							state,
							builtinNames: new Set(),
						}).wrap(tool, "host");
				return {
					ok: true,
					result: normalizeToolResult(await managed.executeRaw(raw, context)),
				};
			});
			assertReceiptScopeCurrent(scope);
			sendRequestResult("tool.call", id, result);
		} catch (error) {
			if (scope.connectionSignal.aborted) return;
			sendError(id, {
				code: RPC_ERROR_CODE.RUNTIME_INTERNAL,
				message: scope.ownerSignal.aborted
					? "approval_expired"
					: error instanceof ToolPermissionDenied
						? (error.decision.reason ?? "permission_denied")
						: `tool call failed: ${String(error)}`,
			});
		}
	};

	return {
		handleToolCall,
	};
};
