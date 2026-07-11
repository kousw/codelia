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

const schemaAllowsNull = (schema: JSONSchema7): boolean => {
	if (schema.type === "null") return true;
	if (Array.isArray(schema.type) && schema.type.includes("null")) return true;
	return [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])].some(
		(variant) =>
			variant !== true &&
			variant !== false &&
			schemaAllowsNull(variant as JSONSchema7),
	);
};

const withOptionalNullHint = (description: string | undefined): string => {
	const hint =
		"Pass null to omit this optional value and use its default behavior.";
	if (!description) return hint;
	return description.includes(hint) ? description : `${description} ${hint}`;
};

const nullableOptionalProperty = (schema: JSONSchema7): JSONSchema7 => {
	if (schemaAllowsNull(schema)) {
		return { ...schema, description: withOptionalNullHint(schema.description) };
	}
	const { description, ...inner } = schema;
	return {
		description: withOptionalNullHint(description),
		anyOf: [inner, { type: "null" }],
	};
};

const toStrictToolSchema = (schema: JSONSchema7): JSONSchema7 => {
	const originalRequired = new Set(schema.required ?? []);
	const next = { ...schema };

	if (next.type === "object") {
		next.additionalProperties ??= false;
		if (next.properties) {
			const properties: Record<string, JSONSchema7> = {};
			for (const [key, property] of Object.entries(next.properties)) {
				const normalized = toStrictToolSchema(property as JSONSchema7);
				properties[key] = originalRequired.has(key)
					? normalized
					: nullableOptionalProperty(normalized);
			}
			next.properties = properties;
			const propertyKeys = Object.keys(properties);
			if (propertyKeys.length > 0) next.required = propertyKeys;
		}
	}

	if (next.items) {
		next.items = Array.isArray(next.items)
			? next.items.map((item) => toStrictToolSchema(item as JSONSchema7))
			: toStrictToolSchema(next.items as JSONSchema7);
	}
	if (next.anyOf) {
		next.anyOf = next.anyOf.map((item) =>
			item === true || item === false
				? item
				: toStrictToolSchema(item as JSONSchema7),
		);
	}
	if (next.oneOf) {
		next.oneOf = next.oneOf.map((item) =>
			item === true || item === false
				? item
				: toStrictToolSchema(item as JSONSchema7),
		);
	}
	if (next.allOf) {
		next.allOf = next.allOf.map((item) =>
			item === true || item === false
				? item
				: toStrictToolSchema(item as JSONSchema7),
		);
	}
	if (next.not) {
		next.not = toStrictToolSchema(next.not as JSONSchema7);
	}
	if (next.additionalProperties && next.additionalProperties !== true) {
		next.additionalProperties = toStrictToolSchema(
			next.additionalProperties as JSONSchema7,
		);
	}
	return next;
};

const normalizeOptionalNulls = (
	value: unknown,
	schema: JSONSchema7,
): unknown => {
	if (Array.isArray(value) && schema.items && !Array.isArray(schema.items)) {
		return value.map((item) =>
			normalizeOptionalNulls(item, schema.items as JSONSchema7),
		);
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return value;

	const normalized = { ...(value as Record<string, unknown>) };
	if (schema.type === "object" && schema.properties) {
		const required = new Set(schema.required ?? []);
		for (const [key, property] of Object.entries(schema.properties)) {
			if (!(key in normalized)) continue;
			if (normalized[key] === null && !required.has(key)) {
				delete normalized[key];
				continue;
			}
			normalized[key] = normalizeOptionalNulls(
				normalized[key],
				property as JSONSchema7,
			);
		}
	}
	for (const variant of [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])]) {
		if (variant === true || variant === false) continue;
		Object.assign(
			normalized,
			normalizeOptionalNulls(normalized, variant as JSONSchema7),
		);
	}
	return normalized;
};

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

export function defineTool<TInput, TResult extends ToolReturn>(
	toolOptions: DefineToolOptions<TInput, TResult>,
): Tool {
	const parameters = toJSONSchema(toolOptions.input, {
		target: "draft-07",
		io: "input",
	}) as JSONSchema7;
	const strictParameters = withTopLevelObjectTypeForObjectUnions(
		toStrictToolSchema(parameters),
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
			const parsed = toolOptions.input.safeParse(
				normalizeOptionalNulls(rawArgs, parameters),
			);
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
