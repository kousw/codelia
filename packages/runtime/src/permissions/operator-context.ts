import type { ToolContext } from "@codelia/core";

const operators = new WeakMap<ToolContext, string>();

export const setOperatorContext = (context: ToolContext, id: string): void => {
	operators.set(context, id);
};

export const getOperatorContext = (context: ToolContext): string | undefined =>
	operators.get(context);
