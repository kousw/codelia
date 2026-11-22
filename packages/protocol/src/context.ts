import { ContextUsageSchema, wireInt } from "@codelia/shared-types";
import { z } from "zod";
import { SkillCatalogWireSchema } from "./skills";

export const ContextInspectParamsSchema = z
	.object({
		include_agents: z.boolean().optional(),
		include_skills: z.boolean().optional(),
	})
	.meta({ id: "ContextInspectParams" });
export type ContextInspectParams = z.infer<typeof ContextInspectParamsSchema>;

export const ContextInspectFileSchema = z
	.object({
		path: z.string(),
		mtime_ms: wireInt(),
		size_bytes: wireInt(),
	})
	.meta({ id: "ContextInspectFile" });
export type ContextInspectFile = z.infer<typeof ContextInspectFileSchema>;

export const ContextInspectAgentsSchema = z
	.object({
		enabled: z.boolean(),
		root_dir: z.string(),
		working_dir: z.string(),
		covered_dirs: z.array(z.string()),
		initial_files: z.array(ContextInspectFileSchema),
		loaded_files: z.array(ContextInspectFileSchema),
	})
	.meta({ id: "ContextInspectAgents" });
export type ContextInspectAgents = z.infer<typeof ContextInspectAgentsSchema>;

export const ContextInspectSkillsLoadedVersionSchema = z
	.object({ path: z.string(), mtime_ms: wireInt() })
	.meta({ id: "ContextInspectSkillsLoadedVersion" });
export type ContextInspectSkillsLoadedVersion = z.infer<
	typeof ContextInspectSkillsLoadedVersionSchema
>;

export const ContextInspectSkillsSchema = z
	.object({
		root_dir: z.string(),
		working_dir: z.string(),
		catalog: SkillCatalogWireSchema,
		loaded_versions: z.array(ContextInspectSkillsLoadedVersionSchema),
	})
	.meta({ id: "ContextInspectSkills" });
export type ContextInspectSkills = z.infer<typeof ContextInspectSkillsSchema>;

export const ContextInspectUiContextSchema = z
	.object({
		cwd: z.string().optional(),
		workspace_root: z.string().optional(),
		active_file_path: z.string().optional(),
	})
	.meta({ id: "ContextInspectUiContext" });

export const ContextInspectResultSchema = z
	.object({
		runtime_working_dir: z.string().optional(),
		runtime_sandbox_root: z.string().optional(),
		execution_environment: z.string().optional(),
		ui_context: ContextInspectUiContextSchema.optional(),
		/** Open diagnostic object. */
		runtime_environment: z.record(z.string(), z.unknown()).optional(),
		agents: ContextInspectAgentsSchema.optional(),
		skills: ContextInspectSkillsSchema.optional(),
	})
	.meta({ id: "ContextInspectResult" });
export type ContextInspectResult = z.infer<typeof ContextInspectResultSchema>;

export const ContextUsageParamsSchema = z
	.object({})
	.meta({ id: "ContextUsageParams" });
export type ContextUsageParams = Record<string, never>;

/**
 * `context.usage` result. Without a built agent: `basis: "none"`, null counts
 * and an empty breakdown (the request never builds an agent or prompts).
 */
export const ContextUsageResultSchema = ContextUsageSchema.extend({
	session_id: z.string().optional(),
}).meta({ id: "ContextUsageResult" });
export type ContextUsageResult = z.infer<typeof ContextUsageResultSchema>;

/** Opt-in (`supports_context_usage`) notification after each model call. */
export const RunContextUsageNotifySchema = ContextUsageSchema.extend({
	run_id: z.string(),
}).meta({ id: "RunContextUsageNotify" });
export type RunContextUsageNotify = z.infer<typeof RunContextUsageNotifySchema>;
