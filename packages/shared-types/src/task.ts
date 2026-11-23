import { z } from "zod";
import { nullish, wireInt } from "./wire";

/** Stable delegated-task metadata shared by runtime, storage, and protocol. */
export const TaskTerminationReasonSchema = z
	.enum([
		"normal",
		"max_steps",
		"timeout",
		"cancelled",
		"startup_error",
		"execution_error",
	])
	.meta({ id: "TaskTerminationReason" });
export type TaskTerminationReason = z.infer<typeof TaskTerminationReasonSchema>;

export const SubagentLineageSchema = z
	.object({
		/** Immutable agent display name; absent on older records. */
		name: z.string().optional(),
		tree_id: z.string(),
		node_id: z.string(),
		parent_node_id: z.string(),
		owner_session_id: z.string(),
		depth: z.literal(1),
		spawn_index: wireInt(),
		// Open: only "fresh" today; spawn params already name resume and fork.
		context_mode: z.enum(["fresh"]),
		effective_policy_id: z.string(),
		workspace_lease_id: z.string(),
	})
	.meta({ id: "SubagentLineage" });
export type SubagentLineage = z.infer<typeof SubagentLineageSchema>;

export const TaskUsageSchema = z
	.object({
		total_tokens: wireInt(),
		/** Absent and `null` both mean the cost is unknown. */
		total_cost_usd: nullish(z.number()),
	})
	.meta({ id: "TaskUsage" });
export type TaskUsage = z.infer<typeof TaskUsageSchema>;

export const TaskProgressCurrentToolSchema = z
	.object({
		name: z.string(),
		tool_call_id: z.string(),
		started_at: z.string(),
	})
	.meta({ id: "TaskProgressCurrentTool" });

export const TaskProgressLastToolSchema = z
	.object({
		name: z.string(),
		status: z.enum(["ok", "error"]),
		finished_at: z.string(),
	})
	.meta({ id: "TaskProgressLastTool" });

/**
 * Parent-visible progress of a running subagent. Counts, phase and tool names
 * only; arguments and results stay in the child session.
 */
export const TaskProgressSchema = z
	.object({
		/** Model calls started so far (1-based once the first call starts). */
		step: wireInt(),
		max_steps: wireInt().optional(),
		phase: z.enum(["model", "tool", "compacting", "finishing"]),
		current_tool: TaskProgressCurrentToolSchema.optional(),
		last_tool: TaskProgressLastToolSchema.optional(),
		/** Tool calls requested so far. */
		tool_calls: wireInt(),
		updated_at: z.string(),
	})
	.meta({ id: "TaskProgress" });
export type TaskProgress = z.infer<typeof TaskProgressSchema>;

/** Stored peer content is untrusted; accepted does not mean acted on by a model. */
export type AgentMessage = {
	message_id: string;
	sender: string;
	sender_name?: string;
	recipient: string;
	recipient_name?: string;
	created_at: string;
	content: string;
};
