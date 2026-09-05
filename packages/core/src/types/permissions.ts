import type { ToolContext } from "../tools/context";
import type { ToolCall } from "./llm";

export type ToolPermissionDecision = {
	decision: "allow" | "deny";
	reason?: string;
	// When true, agent should stop the current turn and wait for next user input.
	stop_turn?: boolean;
};

/** Carries a permission decision made inside a tool's shared execution gate. */
export class ToolPermissionDenied extends Error {
	constructor(readonly decision: ToolPermissionDecision) {
		super(`Permission denied${decision.reason ? `: ${decision.reason}` : ""}`);
		this.name = "ToolPermissionDenied";
	}
}

export type ToolPermissionHook = (
	call: ToolCall,
	rawArgs: string,
	ctx: ToolContext,
) => Promise<ToolPermissionDecision> | ToolPermissionDecision;
