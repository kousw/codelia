import { describe, expect, test } from "bun:test";
import { toResponsesTools } from "../src/llm/openai/serializer";
import type { ToolDefinition } from "../src/types/llm/tools";

describe("toResponsesTools strict mapping", () => {
	const baseTool: Omit<ToolDefinition, "strict"> = {
		name: "sample_tool",
		description: "sample tool",
		parameters: {
			type: "object",
			properties: {
				value: { type: "string" },
			},
		},
	};

	test("defaults strict=false when tool.strict is undefined", () => {
		const tools = toResponsesTools([baseTool]);
		expect(tools).toHaveLength(1);
		const mapped = tools?.[0];
		if (!mapped || mapped.type !== "function") {
			throw new Error("expected function tool");
		}
		expect(mapped.strict).toBe(false);
	});

	test("forwards strict=true when explicitly provided", () => {
		const tools = toResponsesTools([{ ...baseTool, strict: true }]);
		expect(tools).toHaveLength(1);
		const mapped = tools?.[0];
		if (!mapped || mapped.type !== "function") {
			throw new Error("expected function tool");
		}
		expect(mapped.strict).toBe(true);
	});

	test("forwards strict=false when explicitly provided", () => {
		const tools = toResponsesTools([{ ...baseTool, strict: false }]);
		expect(tools).toHaveLength(1);
		const mapped = tools?.[0];
		if (!mapped || mapped.type !== "function") {
			throw new Error("expected function tool");
		}
		expect(mapped.strict).toBe(false);
	});
});
