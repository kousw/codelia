import { describe, expect, test } from "bun:test";
import { toAnthropicTools } from "../src/llm/anthropic/serializer";

describe("toAnthropicTools hosted search mapping", () => {
	test("maps hosted search tool to web_search_20250305", () => {
		const tools = toAnthropicTools([
			{
				type: "hosted_search",
				name: "web_search",
				provider: "anthropic",
				allowed_domains: ["example.com"],
				user_location: {
					country: "US",
				},
			},
		]);
		expect(tools).toHaveLength(1);
		const mapped = tools?.[0];
		if (!mapped || mapped.type !== "web_search_20250305") {
			throw new Error("expected anthropic web search tool");
		}
		expect(mapped.name).toBe("web_search");
		expect(mapped.allowed_domains).toEqual(["example.com"]);
		expect(mapped.user_location).toMatchObject({
			type: "approximate",
			country: "US",
		});
	});
});
