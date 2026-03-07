import { describe, expect, test } from "bun:test";
import {
	createModelRegistry,
	resolveProviderModelId,
	type ModelSpec,
} from "../src/models/registry";

describe("resolveProviderModelId", () => {
	test("returns provider model ids for synthetic model entries", () => {
		const registry = createModelRegistry([
			{
				id: "gpt-5.4-1M",
				provider: "openai",
				providerModelId: "gpt-5.4",
				aliases: ["gpt-5.4-1m", "gpt-5.4-full"],
			},
		] satisfies ModelSpec[]);

		expect(resolveProviderModelId(registry, "gpt-5.4-1M", "openai")).toBe(
			"gpt-5.4",
		);
		expect(resolveProviderModelId(registry, "gpt-5.4-full", "openai")).toBe(
			"gpt-5.4",
		);
	});

	test("falls back to the registry id when no provider model id is set", () => {
		const registry = createModelRegistry([
			{
				id: "gpt-5.4",
				provider: "openai",
			},
		] satisfies ModelSpec[]);

		expect(resolveProviderModelId(registry, "gpt-5.4", "openai")).toBe(
			"gpt-5.4",
		);
	});
});
