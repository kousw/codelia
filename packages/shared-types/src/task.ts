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
