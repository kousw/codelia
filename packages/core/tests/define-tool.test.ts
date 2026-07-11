import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { defineTool } from "../src/tools/define";

describe("defineTool schema normalization", () => {
	test("keeps optional inputs optional in non-strict schemas", async () => {
		const tool = defineTool({
			name: "optional_input",
			description: "test tool",
			input: z.object({
				required_value: z.string(),
				optional_value: z.string().optional(),
				default_value: z.number().default(5),
				required_nullable: z.string().nullable(),
			}),
			execute: (input) => input,
		});
		const definition = tool.definition;
		if (definition.type === "hosted_search") {
			throw new Error("expected function tool definition");
		}

		expect(definition.strict).toBe(false);
		expect(definition.parameters.required).toEqual([
			"required_value",
			"required_nullable",
		]);
		const properties = definition.parameters.properties as Record<
			string,
			{ anyOf?: Array<{ type?: string }>; description?: string }
		>;
		expect(properties.optional_value.anyOf).toBeUndefined();
		expect(properties.default_value.anyOf).toBeUndefined();
		expect(properties.required_nullable.anyOf?.at(-1)?.type).toBe("null");
		expect(properties.optional_value.description).toBeUndefined();

		const result = await tool.executeRaw(
			JSON.stringify({
				required_value: "required",
				required_nullable: null,
			}),
			{
				deps: {},
				resolve: async (key) => key.create(),
			},
		);
		expect(result).toEqual({
			type: "json",
			value: {
				required_value: "required",
				default_value: 5,
				required_nullable: null,
			},
		});
	});

	test("adds top-level object type for object-union input schemas", () => {
		const inputSchema = z.union([
			z.object({
				mode: z.literal("replace"),
				todos: z.array(z.object({ content: z.string() })),
			}),
			z.object({
				mode: z.literal("patch"),
				updates: z.array(z.object({ id: z.string() })),
			}),
		]);
		const tool = defineTool({
			name: "todo_write",
			description: "test tool",
			input: inputSchema,
			execute: () => "ok",
		});
		const definition = tool.definition;
		if (definition.type === "hosted_search") {
			throw new Error("expected function tool definition");
		}

		expect(definition.parameters.type).toBe("object");
		expect(
			Array.isArray((definition.parameters as { anyOf?: unknown }).anyOf),
		).toBe(true);
	});
});
