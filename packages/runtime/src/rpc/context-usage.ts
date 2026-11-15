import type { Agent } from "@codelia/core";
import {
	type ContextUsageResult,
	RPC_ERROR_CODE,
	type RpcNotification,
	type RunContextUsageNotify,
} from "@codelia/protocol";
import type { ContextUsage } from "@codelia/shared-types";
import type { RuntimeState } from "../runtime-state";
import { sendError, sendNotificationAsync, sendResult } from "./transport";

/** Usage before any agent exists; never builds one (no auth prompts). */
const emptyUsage = (state: RuntimeState): ContextUsage => ({
	provider: state.currentModelProvider,
	model: state.currentModelName,
	limit_tokens: null,
	used_tokens: null,
	input_tokens: null,
	left_percent: null,
	basis: "none",
	breakdown: [],
});

export const createContextUsageHandlers = ({
	state,
	log,
}: {
	state: RuntimeState;
	log: (message: string) => void;
}) => {
	const handleContextUsage = async (id: string): Promise<void> => {
		try {
			const usage = state.agent
				? state.agent.getContextUsage()
				: emptyUsage(state);
			const result: ContextUsageResult = {
				...usage,
				...(state.sessionId ? { session_id: state.sessionId } : {}),
			};
			sendResult(id, result);
		} catch (error) {
			log(`context.usage failed: ${String(error)}`);
			sendError(id, {
				code: RPC_ERROR_CODE.RUNTIME_INTERNAL,
				message: "context usage unavailable",
			});
		}
	};
	return { handleContextUsage };
};

/**
 * Tracks one run's opt-in `run.context.usage` stream: emits after each completed
 * model call (a new provider usage object) and after compaction.
 */
export const createRunContextUsageEmitter = (options: {
	state: RuntimeState;
	runId: string;
	agent: Agent;
	log: (message: string) => void;
}) => {
	const { state, runId, agent, log } = options;
	const enabled = state.uiCapabilities?.supports_context_usage === true;
	let lastUsage = enabled ? agent.getLastUsage() : null;
	return (eventType: string): void => {
		if (!enabled) return;
		const usage = agent.getLastUsage();
		if (usage === lastUsage && eventType !== "compaction_complete") return;
		lastUsage = usage;
		try {
			const notify: RpcNotification = {
				jsonrpc: "2.0",
				method: "run.context.usage",
				params: {
					run_id: runId,
					...agent.getContextUsage(),
				} satisfies RunContextUsageNotify,
			};
			void sendNotificationAsync(state, notify);
		} catch (error) {
			// Derived, best-effort data: never fail the run over it.
			log(`run.context.usage emit failed: ${String(error)}`);
		}
	};
};
