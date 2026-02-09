import type { ToolContext } from "../tools/context";
import type { ToolCall } from "./llm";

export type ToolPermissionDecision = {
	decision: "allow" | "deny";
	reason?: string;
	// When true, agent should stop the current turn and wait for next user input.
	stop_turn?: boolean;
};

export type ToolPermissionHook = (
	call: ToolCall,
	rawArgs: string,
	ctx: ToolContext,
) => Promise<ToolPermissionDecision> | ToolPermissionDecision;
