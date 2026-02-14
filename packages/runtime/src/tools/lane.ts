import type { DependencyKey, Tool } from "@codelia/core";
import { defineTool } from "@codelia/core";
import { z } from "zod";
import {
	LaneManager,
	LaneManagerError,
	type LaneBackend,
	type LaneRecord,
} from "../lanes";
import { getSandboxContext, type SandboxContext } from "../sandbox/context";

const laneManager = new LaneManager();

const backendSchema = z.enum(["tmux", "zellij"] as const);

const formatError = (error: unknown): Error => {
	if (error instanceof LaneManagerError) {
		return new Error(`${error.code}: ${error.message}`);
	}
	if (error instanceof Error) return error;
	return new Error(String(error));
};

const shQuote = (value: string): string => {
	if (!value) return "''";
	return `'${value.replaceAll("'", "'\\''")}'`;
};

const buildLaneHints = (
	lane: LaneRecord,
): {
	attach_command: string | null;
	enter_worktree_command: string;
	status_tool: { name: "lane_status"; args: { lane_id: string } };
	close_tool: { name: "lane_close"; args: { lane_id: string } };
} => {
	const attachCommand =
		lane.mux_backend === "tmux"
			? `tmux attach -t ${shQuote(lane.mux_target)}`
			: lane.mux_backend === "zellij"
				? `zellij attach ${shQuote(lane.mux_target)}`
				: null;
	return {
		attach_command: attachCommand,
		enter_worktree_command: `cd ${shQuote(lane.worktree_path)}`,
		status_tool: {
			name: "lane_status",
			args: { lane_id: lane.lane_id },
		},
		close_tool: {
			name: "lane_close",
			args: { lane_id: lane.lane_id },
		},
	};
};

export const createLaneCreateTool = (
	sandboxKey: DependencyKey<SandboxContext>,
): Tool =>
	defineTool({
		name: "lane_create",
		description:
			"Create a Task lane (worktree slot) and start autonomous execution in tmux/zellij.",
		input: z.object({
			task_id: z.string().describe("Task identifier."),
			base_ref: z
				.string()
				.optional()
				.describe("Base git ref. Default: HEAD."),
			worktree_path: z
				.string()
				.optional()
				.describe(
					"Optional worktree path override. Default: ~/.codelia/worktrees/<task-slug>-<lane-id8>.",
				),
			mux_backend: backendSchema
				.optional()
				.describe("Multiplexer backend. Default: tmux."),
			seed_context: z
				.string()
				.optional()
				.describe("Optional initial text context."),
		}),
		execute: async (input, ctx) => {
			const sandbox = await getSandboxContext(ctx, sandboxKey);
			try {
				const lane = await laneManager.create(
					{
						task_id: input.task_id,
						base_ref: input.base_ref,
						worktree_path: input.worktree_path,
						mux_backend: input.mux_backend as LaneBackend | undefined,
						seed_context: input.seed_context,
					},
					{ workingDir: sandbox.workingDir },
				);
				return {
					ok: true,
					lane,
					hints: buildLaneHints(lane),
				};
			} catch (error) {
				throw formatError(error);
			}
		},
	});

export const createLaneListTool = (
	sandboxKey: DependencyKey<SandboxContext>,
): Tool =>
	defineTool({
		name: "lane_list",
		description: "List Task lanes (worktree slots) and current states.",
		input: z.object({
			include_closed: z
				.boolean()
				.optional()
				.describe("Include closed lanes. Default: false."),
		}),
		execute: async (input, ctx) => {
			await getSandboxContext(ctx, sandboxKey);
			try {
				const lanes = await laneManager.list({
					include_closed: input.include_closed,
				});
				return {
					lanes,
					hints: lanes.map((lane) => ({
						lane_id: lane.lane_id,
						...buildLaneHints(lane),
					})),
				};
			} catch (error) {
				throw formatError(error);
			}
		},
	});

export const createLaneStatusTool = (
	sandboxKey: DependencyKey<SandboxContext>,
): Tool =>
	defineTool({
		name: "lane_status",
		description: "Get Task lane status and backend liveness.",
		input: z.object({
			lane_id: z.string().describe("Lane id."),
		}),
		execute: async (input, ctx) => {
			await getSandboxContext(ctx, sandboxKey);
			try {
				const result = await laneManager.status(input.lane_id);
				return {
					...result,
					hints: buildLaneHints(result.lane),
				};
			} catch (error) {
				throw formatError(error);
			}
		},
	});

export const createLaneCloseTool = (
	sandboxKey: DependencyKey<SandboxContext>,
): Tool =>
	defineTool({
		name: "lane_close",
		description: "Close a Task lane and optionally remove its worktree.",
		input: z.object({
			lane_id: z.string().describe("Lane id."),
			remove_worktree: z
				.boolean()
				.optional()
				.describe("Remove worktree. Default: true."),
			force: z.boolean().optional().describe("Force close/cleanup. Default: false."),
		}),
		execute: async (input, ctx) => {
			await getSandboxContext(ctx, sandboxKey);
			try {
				const lane = await laneManager.close({
					lane_id: input.lane_id,
					remove_worktree: input.remove_worktree,
					force: input.force,
				});
				return {
					ok: true,
					lane,
				};
			} catch (error) {
				throw formatError(error);
			}
		},
	});

export const createLaneGcTool = (
	sandboxKey: DependencyKey<SandboxContext>,
): Tool =>
	defineTool({
		name: "lane_gc",
		description: "Close stale finished/error lanes after idle TTL.",
		input: z.object({
			idle_ttl_minutes: z
				.number()
				.int()
				.positive()
				.describe("Idle TTL in minutes."),
			remove_worktree: z
				.boolean()
				.optional()
				.describe("Remove worktree on close. Default: false."),
			force: z
				.boolean()
				.optional()
				.describe("Force cleanup for dirty worktrees. Default: false."),
		}),
		execute: async (input, ctx) => {
			await getSandboxContext(ctx, sandboxKey);
			try {
				return await laneManager.gc({
					idle_ttl_minutes: input.idle_ttl_minutes,
					remove_worktree: input.remove_worktree,
					force: input.force,
				});
			} catch (error) {
				throw formatError(error);
			}
		},
	});
