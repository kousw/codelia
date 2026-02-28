import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { defineTool } from "../src/tools/define";

describe("defineTool schema normalization", () => {
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
