import type { ZodSchema } from "zod";
import type {
	ToolDefinition,
	ToolMessage,
	ToolResult,
	ToolReturn,
} from "../types/llm";
import type { ToolContext } from "./context";

export type DefineToolOptions<
	TInput,
	TResult extends ToolReturn = ToolReturn,
> = {
	name: string;
	description: string;
	/** Optional transcript/diagnostic substitute for sensitive model-facing results. */
	displayResult?: string;
	input: ZodSchema<TInput>;
	execute: (input: TInput, ctx: ToolContext) => Promise<TResult> | TResult;
};

export type Tool = {
	name: string;
	description: string;
	displayResult?: string;
	definition: ToolDefinition; // parameters は JSON Schema
	/** Validate arguments without executing the tool. */
	validateRaw?: (rawArgsJson: string) => void;
	executeRaw: (rawArgsJson: string, ctx: ToolContext) => Promise<ToolResult>;
};

export type ToolExecution = {
	message: ToolMessage;
	done?: boolean;
	finalMessage?: string;
	approvalWaitMs?: number;
	execDurationMs?: number;
};
