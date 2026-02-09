import type { DependencyKey, Tool } from "@codelia/core";
import { defineTool } from "@codelia/core";
import { z } from "zod";
import type { SkillsResolver } from "../skills";
import { getSkillsResolver } from "../skills";

export const createSkillSearchTool = (
	skillsResolverKey: DependencyKey<SkillsResolver>,
): Tool =>
	defineTool({
		name: "skill_search",
		description: "Search installed local skills by name, description, or path.",
		input: z.object({
			query: z.string().min(1).describe("Search query text."),
			limit: z
				.number()
				.int()
				.positive()
				.optional()
				.describe("Optional max result count (clamped by config)."),
			scope: z
				.enum(["repo", "user"])
				.optional()
				.describe("Optional scope filter."),
		}),
		execute: async (input, ctx) => {
			try {
				const resolver = await getSkillsResolver(ctx, skillsResolverKey);
				const result = await resolver.search(input);
				return {
					query: input.query,
					count: result.results.length,
					truncated: result.truncated,
					results: result.results.map((entry) => ({
						score: entry.score,
						reason: entry.reason,
						skill: entry.skill,
					})),
				};
			} catch (error) {
				return `Error searching skills: ${String(error)}`;
			}
		},
	});
