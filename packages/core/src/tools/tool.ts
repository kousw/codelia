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
	input: ZodSchema<TInput>;
	execute: (input: TInput, ctx: ToolContext) => Promise<TResult> | TResult;
};

export type Tool = {
	name: string;
	description: string;
	definition: ToolDefinition; // parameters は JSON Schema
	executeRaw: (rawArgsJson: string, ctx: ToolContext) => Promise<ToolResult>;
};

export type ToolExecution = {
	message: ToolMessage;
	done?: boolean;
	finalMessage?: string;
};
