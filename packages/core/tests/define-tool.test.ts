import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { ToolContext } from "../src/tools/context";
import { defineTool, prepareToolInvocation } from "../src/tools/define";

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

	test("binds one normalization to the exact executor and keeps raw tools executable", async () => {
		let validations = 0;
		let executions = 0;
		const tool = defineTool({
			name: "normalized_input",
			description: "test tool",
			input: z.object({
				value: z.string().overwrite((value) => {
					validations++;
					return value.trim();
				}),
			}),
			execute: (input) => {
				executions++;
				return input;
			},
		});
		const raw = '{"value":"  exact  "}';
		const context: ToolContext = {
			deps: {},
			resolve: async (key) => key.create(),
		};
		const invocation = prepareToolInvocation(tool, raw);
		if (!invocation) throw new Error("missing prepared invocation");
		expect(invocation.input).toEqual({ value: "exact" });
		expect([validations, executions]).toEqual([1, 0]);
		expect(await invocation.execute(context)).toEqual({
			type: "json",
			value: { value: "exact" },
		});
		expect([validations, executions]).toEqual([1, 1]);
		expect(prepareToolInvocation({ ...tool }, raw)).toBeUndefined();
		const original = tool.executeRaw;
		tool.executeRaw = async () => ({ type: "text", text: "wrapped" });
		expect(prepareToolInvocation(tool, raw)).toBeUndefined();
		expect(await tool.executeRaw(raw, context)).toEqual({
			type: "text",
			text: "wrapped",
		});
		await original(raw, context);
		expect([validations, executions]).toEqual([2, 2]);
	});
});
