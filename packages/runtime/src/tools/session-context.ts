import type { DependencyKey, ToolContext } from "@codelia/core";

export type ToolSessionContext = {
	sessionId: string | null;
};

export const createToolSessionContextKey = (
	getSessionId: () => string | null,
): DependencyKey<ToolSessionContext> => ({
	id: "tool-session-context",
	create: () => {
		const sessionId = getSessionId()?.trim() || null;
		return { sessionId };
	},
});

export const getToolSessionContext = async (
	ctx: ToolContext,
	key: DependencyKey<ToolSessionContext>,
): Promise<ToolSessionContext> => ctx.resolve(key);
