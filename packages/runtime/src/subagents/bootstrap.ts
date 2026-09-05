import path from "node:path";
import { z } from "zod";
import { subagentModelSchema } from "./model";
import { subagentNameSchema } from "./names";
import { WRITABLE_TOOLS } from "./contracts";

const permissionRule = z
	.object({
		tool: z.string(),
		command: z.string().optional(),
		command_glob: z.string().optional(),
		skill_name: z.string().optional(),
	})
	.passthrough();
export const subagentBootstrapSchema = z
	.object({
		version: z.literal(1),
		task_id: z.string().uuid(),
		prompt: z.string().min(1).max(32768),
		workspace_root: z.string().refine(path.isAbsolute),
		lineage: z
			.object({
				name: subagentNameSchema.optional(),
				tree_id: z.string().min(1),
				node_id: z.string().uuid(),
				parent_node_id: z.string().min(1),
				owner_session_id: z.string().min(1),
				depth: z.literal(1),
				spawn_index: z.number().int().positive(),
				context_mode: z.literal("fresh"),
				effective_policy_id: z.string().min(1),
				workspace_lease_id: z.string().min(1),
			})
			.strict(),
		model: subagentModelSchema,
		permission: z
			.object({
				tool_allowlist: z.array(z.enum(WRITABLE_TOOLS)).max(7),
				workspace_access: z.enum(["read-only", "read-write"]),
				approval_mode: z.enum(["minimal", "trusted", "full-access"]),
				parent_permissions: z
					.object({
						allow: z.array(permissionRule).optional(),
						deny: z.array(permissionRule).optional(),
					})
					.strict()
					.optional(),
				max_steps: z.number().int().min(1).max(200),
				timeout_seconds: z.number().int().min(1).max(3600).optional(),
			})
			.strict(),
	})
	.strict()
	.refine(
		(input) =>
			input.lineage.node_id === input.task_id &&
			input.lineage.workspace_lease_id === input.task_id &&
			(input.permission.workspace_access === "read-write" ||
				input.permission.tool_allowlist.every(
					(tool) => !["edit", "write", "shell"].includes(tool),
				)),
	);
