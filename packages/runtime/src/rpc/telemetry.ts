import { RPC_ERROR_CODE, type TelemetryGetResult } from "@codelia/protocol";
import type { ContextUsage } from "@codelia/shared-types";
import type { RuntimeState } from "../runtime-state";
import type { AgentTreeCoordinator } from "../subagents/coordinator";
import { sendRequestResult } from "./protocol";
import { getTransportBackpressureEvents, sendError } from "./transport";

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

export const createTelemetryHandlers = ({
	state,
	subagents,
	log,
}: {
	state: RuntimeState;
	subagents?: AgentTreeCoordinator;
	log: (message: string) => void;
}) => {
	const handleTelemetryGet = async (id: string): Promise<void> => {
		try {
			const context = state.agent
				? state.agent.getContextUsage()
				: emptyUsage(state);
			const mem = process.memoryUsage();
			const subagentStats = subagents?.getPerfStats() ?? {
				active: 0,
				maxConcurrent: 0,
			};
			const result: TelemetryGetResult = {
				...(state.sessionId ? { session_id: state.sessionId } : {}),
				active_run_id: state.activeRunId,
				context,
				session_summary: state.telemetry.getSessionSummary(),
				run_summary: state.telemetry.getRunSummary(),
				recent_calls: state.telemetry.getRecentCalls(),
				recent_tools: state.telemetry.getRecentTools(),
				runtime: {
					startup_phases: state.telemetry.getStartupPhases(),
					agent_init_phases: state.telemetry.getAgentInitPhases(),
					active_subagents: subagentStats.active,
					max_concurrent_subagents: subagentStats.maxConcurrent,
					backpressure_events: getTransportBackpressureEvents(),
					memory: {
						rss_bytes: mem.rss,
						heap_used_bytes: mem.heapUsed,
						heap_total_bytes: mem.heapTotal,
						external_bytes: mem.external,
						array_buffers_bytes: mem.arrayBuffers,
					},
				},
			};
			sendRequestResult("telemetry.get", id, result);
		} catch (error) {
			log(`telemetry.get failed: ${String(error)}`);
			sendError(id, {
				code: RPC_ERROR_CODE.RUNTIME_INTERNAL,
				message: "telemetry unavailable",
			});
		}
	};

	return { handleTelemetryGet };
};
