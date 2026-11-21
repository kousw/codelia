import { randomUUID } from "node:crypto";
import type { ToolOutputCacheStore } from "@codelia/core";
import { z } from "zod";
import {
	createShellAuthorizer,
	type ShellAuthorizer,
} from "../permissions/shell-approval";
import { matchToolRule } from "../permissions/utils";
import { type FileSelection, SandboxContext } from "../sandbox/context";
import type { DirectoryMutationBroker } from "../sandbox/file-mutations";
import type { TaskManager } from "../tasks";
import { startShellTask } from "../tasks/shell-executor";
import { VolatileToolOutputCacheStore } from "../volatile-stores";
import type {
	SubagentApproval,
	SubagentChannel,
	SubagentFileRead,
	SubagentLaunchInput,
} from "./contracts";
import { isSubagentFileRead } from "./contracts";
import type { AgentMailbox } from "./mailbox";
import { subagentTaskInfo } from "./projection";
import { createSubagentReadTools } from "./read-tools";
import { createSubagentWriteTools } from "./write-tools";

const shellInput = z
	.object({
		command: z.string().min(1).max(32768),
		timeout_seconds: z.number().int().min(1).max(300).optional(),
	})
	.strict();

export type SubagentFileAdmission = {
	mutations?: DirectoryMutationBroker;
	readOnlyPaths?: readonly string[];
	read?: SubagentFileReadAdmission;
	dispatch: <T>(
		input: {
			owner: string;
			operation: "write" | "edit";
			rawArgs: string;
			sandbox: SandboxContext;
			selected: FileSelection;
			signal?: AbortSignal;
		},
		execute: (consume: () => void) => Promise<T>,
	) => Promise<T>;
};

export type SubagentFileReadAdmission = (request: {
	owner: string;
	workspace: string;
	operation: SubagentFileRead;
	rawArgs: string;
	signal?: AbortSignal;
}) => Promise<{
	permits: (target: string) => boolean;
	checkCurrent: () => void;
	protectedPaths: readonly string[];
}>;

export const createParentChannel = ({
	tasks,
	mailbox,
	owner,
	sender,
	launch,
	approval,
	authorizeShell,
	parentRunId,
	fileAdmission,
	outputCache = new VolatileToolOutputCacheStore(),
}: {
	tasks: TaskManager;
	mailbox: AgentMailbox;
	owner: string;
	sender: string;
	launch?: SubagentLaunchInput;
	approval?: SubagentApproval;
	authorizeShell?: ShellAuthorizer;
	parentRunId?: string;
	fileAdmission?: SubagentFileAdmission;
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
		if (
			launch.permission.parent_permissions?.deny?.some((rule) =>
				matchToolRule(rule, tool, raw),
			)
		)
			return false;
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
			if (isSubagentFileRead(operation) && launch) {
				const rawArgs = JSON.stringify(raw);
				if (
					!rawArgs ||
					!launch.permission.tool_allowlist.includes(operation) ||
					launch.permission.parent_permissions?.deny?.some(
						(rule) =>
							matchToolRule(rule, operation, rawArgs) ||
							matchToolRule(rule, "read", rawArgs),
					)
				)
					throw new Error("Delegated file permission denied");
				const admission = await fileAdmission?.read?.({
					owner,
					workspace: launch.workspace_root,
					operation,
					rawArgs,
					signal,
				});
				const tool = createSubagentReadTools(
					launch.workspace_root,
					[
						...(launch.protected_paths ?? []),
						...(admission?.protectedPaths ?? []),
					],
					{ permits: admission?.permits },
				).find((tool) => tool.name === operation);
				if (!tool) throw new Error("Unsupported file operation");
				const result = await tool.executeRaw(rawArgs, {
					deps: {},
					signal,
					now: () => new Date(),
					resolve: (key) => Promise.resolve(key.create()),
				});
				signal?.throwIfAborted();
				admission?.checkCurrent();
				if (result.type !== "text") throw new Error("Invalid file read result");
				return result.text;
			}
			if ((operation === "edit" || operation === "write") && launch) {
				const rawArgs = JSON.stringify(raw);
				if (Buffer.byteLength(rawArgs) > 240 * 1024)
					throw new Error("Child file request too large");
				if (
					launch.permission.workspace_access !== "read-write" ||
					!launch.permission.tool_allowlist.includes(operation)
				)
					throw new Error("Delegated file permission denied");
				const execute = async (
					protection?: Parameters<typeof createSubagentWriteTools>[2],
				) => {
					signal?.throwIfAborted();
					const tool = createSubagentWriteTools(
						launch.workspace_root,
						undefined,
						protection,
						launch.protected_paths,
					).find((tool) => tool.name === operation);
					if (!tool) throw new Error("Unsupported file operation");
					const result = await tool.executeRaw(rawArgs, {
						deps: {},
						signal,
						now: () => new Date(),
						resolve: (key) => Promise.resolve(key.create()),
					});
					if (result.type !== "json") throw new Error("Invalid file result");
					return result.value;
				};
				if (fileAdmission) {
					const filePath = z
						.object({ file_path: z.string().min(1) })
						.parse(raw).file_path;
					const sandbox = await SandboxContext.create(launch.workspace_root, {
						sandboxMode: launch.permission.sandbox_mode,
						protectResources: true,
						extraProtectedPaths: launch.protected_paths,
						extraReadOnlyPaths: fileAdmission.readOnlyPaths,
						mutations: fileAdmission.mutations,
					});
					const selected = sandbox.selectFile(filePath, "write");
					const bound = sandbox.bindFiles([selected]);
					return fileAdmission.dispatch(
						{ owner, operation, rawArgs, sandbox: bound, selected, signal },
						(consume) =>
							execute({
								paths: launch.protected_paths ?? [],
								readOnlyPaths: fileAdmission.readOnlyPaths,
								selection: selected,
								bound,
								consume,
							}),
					);
				}
				if (!(await authorize(operation, rawArgs, signal)))
					throw new Error("Delegated file permission denied");
				return execute();
			}
			if (operation !== "shell" || !launch)
				throw new Error("unsupported child operation");
			const params = shellInput.parse(raw);
			if (
				launch.permission.workspace_access !== "read-write" ||
				!launch.permission.tool_allowlist.includes("shell")
			)
				throw new Error("Delegated shell permission denied");
			signal?.throwIfAborted();
			// Shell runs in the owning runtime, so shutdown/recovery owns its process group too.
			const shellApproval =
				authorizeShell ??
				createShellAuthorizer({
					root: launch.workspace_root,
					extraProtectedPaths: launch.protected_paths,
					extraReadOnlyPaths: fileAdmission?.readOnlyPaths,
				});
			const timeoutSeconds = params.timeout_seconds ?? 120;
			const task = await shellApproval(
				{
					source: params.command,
					cwd: launch.workspace_root,
					timeoutSeconds,
					owner,
					origin: "child_agent",
					childSandboxCeiling:
						launch.permission.sandbox_mode === "readonly"
							? "readonly"
							: "workspace-write",
					runId: parentRunId,
					signal,
					deny: launch.permission.parent_permissions?.deny,
				},
				(admission) =>
					tasks.spawn(
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
								timeoutSeconds,
								spawnProcess: () => admission(task.task_id),
								toolName: "shell",
								outputCache,
							}),
					),
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
