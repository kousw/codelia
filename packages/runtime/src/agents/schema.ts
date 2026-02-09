import { z } from "zod";

export const AgentsConfigSchema = z
	.object({
		enabled: z.boolean().optional(),
		root: z
			.object({
				projectRootOverride: z.string().optional(),
				markers: z.array(z.string()).optional(),
				stopAtFsRoot: z.boolean().optional(),
			})
			.optional(),
		initial: z
			.object({
				maxFiles: z.number().int().positive().optional(),
				maxBytes: z.number().int().positive().optional(),
			})
			.optional(),
		resolver: z
			.object({
				enabled: z.boolean().optional(),
				maxFilesPerResolve: z.number().int().positive().optional(),
			})
			.optional(),
	})
	.strict();

export type AgentsConfig = z.infer<typeof AgentsConfigSchema>;

export const ResolvedAgentFileSchema = z
	.object({
		path: z.string(),
		mtimeMs: z.number().nonnegative(),
		sizeBytes: z.number().int().nonnegative(),
	})
	.strict();

export type ResolvedAgentFile = z.infer<typeof ResolvedAgentFileSchema>;

export const ResolvedAgentsSchema = z
	.object({
		files: z.array(ResolvedAgentFileSchema),
	})
	.strict();

export type ResolvedAgents = z.infer<typeof ResolvedAgentsSchema>;

export const SystemReminderTypeSchema = z.enum([
	"agents.resolve.paths",
	"session.resume.diff",
	"tool.output.trimmed",
	"permission.decision",
]);

export type SystemReminderType = z.infer<typeof SystemReminderTypeSchema>;

export const AgentsResolveReasonSchema = z.enum(["new", "updated"]);
export type AgentsResolveReason = z.infer<typeof AgentsResolveReasonSchema>;
