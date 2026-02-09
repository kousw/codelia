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

type SchemaTransform = (schema: JSONSchema7) => JSONSchema7;

const mapSchema = (
	schema: JSONSchema7,
	transform: SchemaTransform,
): JSONSchema7 => {
	if (!schema || typeof schema !== "object") return schema;
	const next = transform({ ...schema });

	if (next.properties) {
		const updated: Record<string, JSONSchema7> = {};
		for (const [key, value] of Object.entries(next.properties)) {
			updated[key] = mapSchema(value as JSONSchema7, transform);
		}
		next.properties = updated;
	}

	if (next.items) {
		if (Array.isArray(next.items)) {
			next.items = next.items.map((item) =>
				mapSchema(item as JSONSchema7, transform),
			);
		} else {
			next.items = mapSchema(next.items as JSONSchema7, transform);
		}
	}

	if (next.anyOf) {
		next.anyOf = next.anyOf.map((item) =>
			mapSchema(item as JSONSchema7, transform),
		);
	}
	if (next.oneOf) {
		next.oneOf = next.oneOf.map((item) =>
			mapSchema(item as JSONSchema7, transform),
		);
	}
	if (next.allOf) {
		next.allOf = next.allOf.map((item) =>
			mapSchema(item as JSONSchema7, transform),
		);
	}
	if (next.not) {
		next.not = mapSchema(next.not as JSONSchema7, transform);
	}

	return next;
};

const withNoAdditionalProperties = (schema: JSONSchema7): JSONSchema7 =>
	mapSchema(schema, (next) => {
		if (next.type === "object" && next.additionalProperties === undefined) {
			next.additionalProperties = false;
		}
		return next;
	});

const withRequiredProperties = (schema: JSONSchema7): JSONSchema7 =>
	mapSchema(schema, (next) => {
		if (next.type === "object" && next.properties) {
			const propertyKeys = Object.keys(next.properties);
			if (propertyKeys.length > 0) {
				next.required = Array.from(
					new Set([...(next.required ?? []), ...propertyKeys]),
				);
			}
		}
		return next;
	});

function toToolResult(value: unknown): ToolResult {
	if (isToolResult(value)) return value;
	if (typeof value === "string") return { type: "text", text: value };
	if (Array.isArray(value) && value.every(isContentPart))
		return { type: "parts", parts: value as ContentPart[] };
	return { type: "json", value };
}

export function defineTool<TInput, TResult extends ToolReturn>(
	toolOptions: DefineToolOptions<TInput, TResult>,
): Tool {
	const parameters = toJSONSchema(toolOptions.input, {
		target: "draft-07",
		io: "input",
	}) as JSONSchema7;
	const strictParameters = withRequiredProperties(
		withNoAdditionalProperties(parameters),
	);

	return {
		name: toolOptions.name,
		description: toolOptions.description,
		definition: {
			name: toolOptions.name,
			description: toolOptions.description,
			parameters: strictParameters,
			strict: true,
		} satisfies ToolDefinition,
		executeRaw: (
			rawArgsJson: string,
			ctx: ToolContext,
		): Promise<ToolResult> => {
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
			const result = toolOptions.execute(parsed.data, ctx);
			if (result instanceof Promise) {
				return result.then((result: TResult) => toToolResult(result));
			}
			return Promise.resolve(toToolResult(result));
		},
	};
}
