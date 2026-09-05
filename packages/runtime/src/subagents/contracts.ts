import type { PermissionsConfig, SubagentConfig } from "@codelia/config";
import type { ApprovalMode, SubagentLineage } from "@codelia/shared-types";
import type { ResolvedModelConfig } from "../config";
import type { PreparedTaskExecution } from "../tasks/prepared";

export const READ_ONLY_TOOLS = [
	"read",
	"read_line",
	"list_files",
	"search_files",
] as const;
export type SubagentLaunchInput = {
	version: 1;
	task_id: string;
	lineage: SubagentLineage;
	prompt: string;
	workspace_root: string;
	model: ResolvedModelConfig;
	permission: {
		tool_allowlist: string[];
		workspace_access: "read-only" | "read-write";
		approval_mode: ApprovalMode;
		parent_permissions?: PermissionsConfig;
		max_steps: number;
		timeout_seconds?: number;
	};
};
export const WRITABLE_TOOLS = [
	...READ_ONLY_TOOLS,
	"edit",
	"write",
	"shell",
] as const;
export type SubagentChannel = {
	request(
		operation: "send" | "receive" | "list" | "shell" | "edit" | "write",
		params: unknown,
		signal?: AbortSignal,
	): Promise<unknown>;
};
export type SubagentApproval = (request: {
	task_name?: string;
	task_id: string;
	owner_session_id: string;
	tool: string;
	raw_args: string;
	signal?: AbortSignal;
}) => Promise<boolean>;
export type SubagentExecutorFactory = {
	isAvailable(): boolean;
	prepare(
		input: SubagentLaunchInput,
		channel?: SubagentChannel,
	): PreparedTaskExecution;
};
export type SubagentParentContext = {
	subagent?: SubagentConfig;
	workspace_root: string;
	model: ResolvedModelConfig;
	approval_mode: ApprovalMode;
	permissions?: PermissionsConfig;
};
