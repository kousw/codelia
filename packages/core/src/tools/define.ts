import type { JSONSchema7 } from "json-schema";
import { toJSONSchema } from "zod";
import type {
	ContentPart,
	ToolDefinition,
	ToolResult,
	ToolReturn,
} from "../types/llm";
import { isContentPart, isToolResult } from "../types/llm";
import type { ToolContext } from "./context";
import type { DefineToolOptions, Tool } from "./tool";

const withTopLevelObjectTypeForObjectUnions = (
	schema: JSONSchema7,
): JSONSchema7 => {
	if (schema.type !== undefined) return schema;
	const variants =
		(Array.isArray(schema.anyOf) && schema.anyOf.length > 0
			? schema.anyOf
			: Array.isArray(schema.oneOf) && schema.oneOf.length > 0
				? schema.oneOf
				: null) ?? null;
	if (!variants) return schema;
	const allObjectVariants = variants.every((variant) => {
		if (!variant || typeof variant !== "object") return false;
		const jsonSchema = variant as JSONSchema7;
		return jsonSchema.type === "object";
	});
	if (!allObjectVariants) return schema;
	return { ...schema, type: "object" };
};

function toToolResult(value: unknown): ToolResult {
	if (isToolResult(value)) return value;
	if (typeof value === "string") return { type: "text", text: value };
	if (Array.isArray(value) && value.every(isContentPart))
		return { type: "parts", parts: value as ContentPart[] };
	return { type: "json", value };
}

type PreparedToolInvocation = {
	input: unknown;
	execute: (context: ToolContext) => Promise<ToolResult>;
};

const preparations = new WeakMap<
	Tool,
	{
		executeRaw: Tool["executeRaw"];
		validateRaw: Tool["validateRaw"];
		prepare: (raw: string) => PreparedToolInvocation;
	}
>();

/** Bind validated input to an exact defineTool executor before runtime admission. */
export function prepareToolInvocation(
	tool: Tool,
	raw: string,
): PreparedToolInvocation | undefined {
	const registration = preparations.get(tool);
	if (
		!registration ||
		registration.executeRaw !== tool.executeRaw ||
		registration.validateRaw !== tool.validateRaw
	)
		return undefined;
	return registration.prepare(raw);
}

export function defineTool<TInput, TResult extends ToolReturn>(
	toolOptions: DefineToolOptions<TInput, TResult>,
): Tool {
	const parameters = toJSONSchema(toolOptions.input, {
		target: "draft-07",
		io: "input",
	}) as JSONSchema7;
	const modelParameters = withTopLevelObjectTypeForObjectUnions(parameters);

	const parse = (rawArgsJson: string): TInput => {
		let rawArgs: unknown;
		try {
			rawArgs = JSON.parse(rawArgsJson) as unknown;
		} catch (error) {
			throw new Error(
				`Invalid tool arguments JSON for ${toolOptions.name}: ${String(error)}`,
			);
		}
		const parsed = toolOptions.input.safeParse(rawArgs);
		if (!parsed.success) {
			throw new Error(
				`Tool input validation failed for ${toolOptions.name}: ${parsed.error.message}`,
			);
		}
		return parsed.data;
	};

	const execute = (
		input: TInput,
		context: ToolContext,
	): Promise<ToolResult> => {
		const result = toolOptions.execute(input, context);
		if (result instanceof Promise) return result.then(toToolResult);
		return Promise.resolve(toToolResult(result));
	};
	const prepare = (raw: string): PreparedToolInvocation => {
		const input = parse(raw);
		return { input, execute: (context) => execute(input, context) };
	};

	const tool: Tool = {
		name: toolOptions.name,
		description: toolOptions.description,
		...(toolOptions.displayResult
			? { displayResult: toolOptions.displayResult }
			: {}),
		definition: {
			name: toolOptions.name,
			description: toolOptions.description,
			parameters: modelParameters,
			strict: false,
		} satisfies ToolDefinition,
		validateRaw: (raw) => {
			parse(raw);
		},
		executeRaw: (raw, context) => execute(parse(raw), context),
	};
	preparations.set(tool, {
		executeRaw: tool.executeRaw,
		validateRaw: tool.validateRaw,
		prepare,
	});
	return tool;
}
