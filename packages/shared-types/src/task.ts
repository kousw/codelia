/** Stable delegated-task metadata shared by runtime, storage, and protocol. */
export type TaskTerminationReason =
	| "normal"
	| "max_steps"
	| "timeout"
	| "cancelled"
	| "startup_error"
	| "execution_error";

export type SubagentLineage = {
	/** Immutable agent display name; absent on older records. */
	name?: string;
	tree_id: string;
	node_id: string;
	parent_node_id: string;
	owner_session_id: string;
	depth: 1;
	spawn_index: number;
	context_mode: "fresh";
	effective_policy_id: string;
	workspace_lease_id: string;
};

export type TaskUsage = {
	total_tokens: number;
	total_cost_usd?: number | null;
};

/**
 * Parent-visible progress of a running subagent. Counts, phase and tool names
 * only; arguments and results stay in the child session.
 */
export type TaskProgress = {
	/** Model calls started so far (1-based once the first call starts). */
	step: number;
	max_steps?: number;
	phase: "model" | "tool" | "compacting" | "finishing";
	current_tool?: { name: string; tool_call_id: string; started_at: string };
	last_tool?: { name: string; status: "ok" | "error"; finished_at: string };
	/** Tool calls requested so far. */
	tool_calls: number;
	updated_at: string;
};

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
