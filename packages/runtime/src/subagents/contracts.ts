import type { PermissionsConfig, SubagentConfig } from "@codelia/config";
import type {
	ApprovalMode,
	SandboxMode,
	SubagentLineage,
} from "@codelia/shared-types";
import type { ResolvedModelConfig } from "../config";
import type { PreparedTaskExecution } from "../tasks/prepared";

const FILE_READ_TOOLS = [
	"read",
	"read_line",
	"list_files",
	"search_files",
] as const;
export const READ_ONLY_TOOLS = [
	...FILE_READ_TOOLS,
	"conversation_search",
	"conversation_read",
] as const;
export type SubagentFileRead = (typeof FILE_READ_TOOLS)[number];
export const isSubagentFileRead = (
	operation: unknown,
): operation is SubagentFileRead =>
	FILE_READ_TOOLS.some((tool) => tool === operation);
export type SubagentLaunchInput = {
	version: 1;
	task_id: string;
	lineage: SubagentLineage;
	prompt: string;
	workspace_root: string;
	protected_paths?: string[];
	model: ResolvedModelConfig;
	permission: {
		tool_allowlist: string[];
		workspace_access: "read-only" | "read-write";
		approval_mode?: ApprovalMode;
		sandbox_mode?: SandboxMode;
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
		operation:
			| "send"
			| "receive"
			| "list"
			| "shell"
			| "edit"
			| "write"
			| SubagentFileRead,
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
	protected_paths?: string[];
	model: ResolvedModelConfig;
	approval_mode?: ApprovalMode;
	sandbox_mode?: SandboxMode;
	permissions?: PermissionsConfig;
};
