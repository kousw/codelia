import type { DependencyKey, Tool } from "@codelia/core";
import { defineTool } from "@codelia/core";
import { z } from "zod";
import type { SkillsResolver } from "../skills";
import { getSkillsResolver } from "../skills";

const SkillLoadInputSchema = z
	.object({
		name: z.string().min(1).optional().describe("Exact skill name to load."),
		path: z
			.string()
			.min(1)
			.optional()
			.describe("Absolute or workspace-relative path to SKILL.md."),
	})
	.refine((value) => !!value.name || !!value.path, {
		message: "name or path is required",
		path: ["name"],
	});

export const createSkillLoadTool = (
	skillsResolverKey: DependencyKey<SkillsResolver>,
): Tool =>
	defineTool({
		name: "skill_load",
		description: "Load full SKILL.md content by exact name or path.",
		input: SkillLoadInputSchema,
		execute: async (input, ctx) => {
			try {
				const resolver = await getSkillsResolver(ctx, skillsResolverKey);
				const result = await resolver.load(input);
				if (!result.ok) {
					return {
						ok: false,
						error: result.message,
						ambiguous_paths: result.ambiguous_paths ?? [],
						already_loaded: null,
						skill: null,
						content: null,
						files: [],
						files_truncated: false,
					};
				}
				return {
					ok: true,
					error: null,
					ambiguous_paths: [],
					already_loaded: result.already_loaded,
					skill: result.skill,
					content: result.content,
					files: result.files,
					files_truncated: result.files_truncated,
				};
			} catch (error) {
				return {
					ok: false,
					error: `Error loading skill: ${String(error)}`,
					ambiguous_paths: [],
					already_loaded: null,
					skill: null,
					content: null,
					files: [],
					files_truncated: false,
				};
			}
		},
	});
