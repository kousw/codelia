import type { DependencyKey, ToolContext } from "@codelia/core";
import type { AgentsResolver } from "./resolver";

export const createAgentsResolverKey = (
	resolver: AgentsResolver,
): DependencyKey<AgentsResolver> => ({
	id: "agents-resolver",
	create: () => resolver,
});

export const getAgentsResolver = async (
	ctx: ToolContext,
	key: DependencyKey<AgentsResolver>,
): Promise<AgentsResolver> => ctx.resolve(key);
