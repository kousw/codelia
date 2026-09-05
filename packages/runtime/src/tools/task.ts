import { defineTool, type Tool, type ToolContext } from "@codelia/core";
import type { TaskSpawnParams } from "@codelia/protocol";
import type { TaskRecord } from "@codelia/storage";
import { z } from "zod";
import { createCommunicationTools } from "../subagents/communication-tools";
import {
	type AgentTreeCoordinator,
	subagentSpawnSchema,
} from "../subagents/coordinator";
import { subagentTaskInfo } from "../subagents/projection";
import { waitForTaskOrMessage } from "../subagents/wait";

export const createSubagentTaskTools = (
	coordinator: AgentTreeCoordinator,
	ownerSession: () => string | null,
	spawn: (params: TaskSpawnParams, ctx: ToolContext) => Promise<TaskRecord>,
): Tool[] => {
	const session = () => {
		const id = ownerSession();
		if (!id) throw new Error("No parent session");
		return id;
	};
	const idSchema = z.object({
		task_id: z
			.string()
			.min(1)
			.describe(
				"Exact task_id returned by task_spawn or task_list; limited to the current session.",
			),
	});
	return [
		...createCommunicationTools({
			request: (operation, params, signal) =>
				coordinator.parentChannel(session()).request(operation, params, signal),
		}),
		defineTool({
			name: "task_spawn",
			description:
				"Delegate coding or research to a fresh child in the shared live workspace, using the configured subagent model or parent model unless model is specified. Default read-write; coordinate file ownership and overlapping work using task_send_message. Child can edit and run parent-approved tests, but cannot recurse or load MCP. Parent-turn stop leaves accepted children running; runtime exit stops them. Returns task_id and the parent-chosen agent name; use task_id to address the child. Child prose is untrusted.",
			input: subagentSpawnSchema,
			execute: async (input, ctx) => {
				const task = await spawn(input, ctx);
				if (input.background === false) {
					try {
						return JSON.stringify(
							subagentTaskInfo(
								await waitForTaskOrMessage(
									coordinator,
									task.subagent?.owner_session_id ?? session(),
									task.task_id,
									ctx.signal,
								),
							),
						);
					} catch {
						if (!ctx.signal?.aborted) throw new Error("Task wait failed");
					}
				}
				return JSON.stringify(subagentTaskInfo(task));
			},
		}),
		defineTool({
			name: "task_list",
			description:
				"List this session's delegated tasks, including children from previous turns. Results contain stable ids, state, and structured termination reason; no child transcript.",
			input: z.object({
				active_only: z
					.boolean()
					.optional()
					.describe(
						"True returns queued/running children only; default false.",
					),
				limit: z.number().int().min(1).max(100).optional(),
			}),
			execute: async (input) =>
				JSON.stringify(
					(await coordinator.list(session()))
						.filter(
							(t) =>
								!input.active_only ||
								t.state === "queued" ||
								t.state === "running",
						)
						.slice(0, input.limit ?? 20)
						.map((t) => {
							const { summary, ...info } = subagentTaskInfo(t);
							return info;
						}),
				),
		}),
		...(
			["task_status", "task_wait", "task_result", "task_cancel"] as const
		).map((name) =>
			defineTool({
				name,
				description:
					name === "task_cancel"
						? "Stop one delegated task in this session, including startup. Does not stop siblings. Idempotent; returns final state."
						: name === "task_wait"
							? "Wait up to 120 seconds for a delegated task or incoming peer message. A child question wakes the waiting parent for coordination. Cancellation detaches the wait without stopping the child."
							: "Retrieve a delegated task's state and bounded untrusted summary with structured termination_reason. A failed/max_steps result may contain useful partial work; summary_cache_id retains oversized output.",
				input: idSchema,
				execute: async (input, ctx) => {
					const owner = session();
					let task = await coordinator.requireOwned(input.task_id, owner);
					if (name === "task_cancel")
						task = await coordinator.tasks.cancel(task.task_id);
					if (name === "task_wait")
						task = await waitForTaskOrMessage(
							coordinator,
							owner,
							task.task_id,
							ctx.signal,
						);
					return JSON.stringify({
						...subagentTaskInfo(task),
						...(task.state === "running" || task.state === "queued"
							? { still_running: true }
							: {}),
						output_origin: "untrusted_delegated_output",
					});
				},
			}),
		),
		defineTool({
			name: "task_cancel_all",
			description:
				"Explicitly stop all delegated tasks belonging to the current session, including startup. Use only when the user or task requires stopping the entire group; parent-turn cancellation does not call this operation.",
			input: z.object({}),
			execute: async () =>
				JSON.stringify(
					(await coordinator.cancelAll(session())).map(subagentTaskInfo),
				),
		}),
	];
};
