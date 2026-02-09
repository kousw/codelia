import type { DependencyKey, ToolContext } from "@codelia/core";
import type { SkillsResolver } from "./resolver";

export const createSkillsResolverKey = (
	resolver: SkillsResolver,
): DependencyKey<SkillsResolver> => ({
	id: "skills-resolver",
	create: () => resolver,
});

export const getSkillsResolver = async (
	ctx: ToolContext,
	key: DependencyKey<SkillsResolver>,
): Promise<SkillsResolver> => ctx.resolve(key);
