import { randomUUID } from "node:crypto";
import type { ToolOutputCacheStore } from "@codelia/core";
import { z } from "zod";
import {
	buildSystemPermissions,
	PermissionService,
} from "../permissions/service";
import type { TaskManager } from "../tasks";
import { startShellTask } from "../tasks/shell-executor";
import { VolatileToolOutputCacheStore } from "../volatile-stores";
import type {
	SubagentApproval,
	SubagentChannel,
	SubagentLaunchInput,
} from "./contracts";
import type { AgentMailbox } from "./mailbox";
import { createSubagentWriteTools } from "./write-tools";
import { subagentTaskInfo } from "./projection";

const shellInput = z
	.object({
		command: z.string().min(1).max(32768),
		timeout_seconds: z.number().int().min(1).max(300).optional(),
	})
	.strict();

export const createParentChannel = ({
	tasks,
	mailbox,
	owner,
	sender,
	launch,
	approval,
	outputCache = new VolatileToolOutputCacheStore(),
}: {
	tasks: TaskManager;
	mailbox: AgentMailbox;
	owner: string;
	sender: string;
	launch?: SubagentLaunchInput;
	approval?: SubagentApproval;
	outputCache?: ToolOutputCacheStore;
}): SubagentChannel => {
	const authorize = async (
		tool: string,
		raw: string,
		signal?: AbortSignal,
	): Promise<boolean> => {
		signal?.throwIfAborted();
		if (
			launch?.permission.workspace_access !== "read-write" ||
			!launch.permission.tool_allowlist.includes(tool)
		)
			return false;
		const policy = new PermissionService({
			approvalMode: launch.permission.approval_mode,
			user: launch.permission.parent_permissions,
			system: buildSystemPermissions(launch.permission.approval_mode),
			bashPathGuard: {
				rootDir: launch.workspace_root,
				workingDir: launch.workspace_root,
			},
		});
		const decision = policy.evaluate(tool, raw);
		if (decision.decision === "deny") return false;
		if (decision.decision === "allow") return true;
		return (
			(await approval?.({
				task_id: sender,
				task_name: launch.lineage.name,
				owner_session_id: owner,
				tool,
				raw_args: raw,
				signal,
			})) ?? false
		);
	};
	return {
		async request(operation, raw, signal) {
			signal?.throwIfAborted();
			if (sender !== "parent") {
				const task = await mailbox.requireNode(owner, sender);
				if (task.state !== "running" && task.state !== "queued")
					throw new Error("sender_finished");
			}
			if (operation === "send") {
				const params = z
					.object({ recipient: z.string().min(1), content: z.string() })
					.strict()
					.parse(raw);
				return mailbox.send(owner, sender, params.recipient, params.content);
			}
			if (operation === "receive") {
				const params = z
					.object({ wait_seconds: z.number().min(0).max(120).optional() })
					.strict()
					.parse(raw);
				return mailbox.receive(owner, sender, params.wait_seconds ?? 0, signal);
			}
			if (operation === "list")
				return (await mailbox.list(owner)).map((task) => {
					const { summary, ...info } = subagentTaskInfo(task);
					return info;
				});
			if ((operation === "edit" || operation === "write") && launch) {
				const rawArgs = JSON.stringify(raw);
				if (Buffer.byteLength(rawArgs) > 240 * 1024)
					throw new Error("Child file request too large");
				if (!(await authorize(operation, rawArgs, signal)))
					throw new Error("Delegated file permission denied");
				signal?.throwIfAborted();
				const tool = createSubagentWriteTools(launch.workspace_root).find(
					(tool) => tool.name === operation,
				);
				if (!tool) throw new Error("Unsupported file operation");
				const result = await tool.executeRaw(rawArgs, {
					deps: {},
					signal,
					now: () => new Date(),
					resolve: (key) => Promise.resolve(key.create()),
				});
				if (result.type !== "json") throw new Error("Invalid file result");
				return result.value;
			}
			if (operation !== "shell" || !launch)
				throw new Error("unsupported child operation");
			const params = shellInput.parse(raw);
			if (!(await authorize("shell", JSON.stringify(params), signal)))
				throw new Error("Delegated shell permission denied");
			signal?.throwIfAborted();
			// Shell runs in the owning runtime, so shutdown/recovery owns its process group too.
			const task = await tasks.spawn(
				{
					task_id: randomUUID(),
					kind: "shell",
					parent_session_id: owner,
					parent_tool_call_id: sender,
					working_directory: launch.workspace_root,
					title: `Subagent ${launch.lineage.name ?? sender}: ${params.command.slice(0, 120)}`,
				},
				({ task }) =>
					startShellTask({
						taskId: task.task_id,
						command: params.command,
						cwd: launch.workspace_root,
						timeoutSeconds: params.timeout_seconds ?? 120,
						toolName: "shell",
						outputCache,
					}),
			);
			let cancellation: Promise<unknown> | undefined;
			let cancellationError: unknown;
			const stop = () => {
				cancellation ??= tasks.cancel(task.task_id).catch((error) => {
					cancellationError = error;
				});
			};
			signal?.addEventListener("abort", stop, { once: true });
			if (signal?.aborted) stop();
			let result: typeof task.result;
			try {
				result = (await tasks.wait(task.task_id)).result;
			} finally {
				signal?.removeEventListener("abort", stop);
				await cancellation;
			}
			if (cancellationError) throw cancellationError;
			return result;
		},
	};
};
