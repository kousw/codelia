import { describe, expect } from "bun:test";
import { ModelMetadataServiceImpl } from "../src";
import { integrationTest } from "./test-helpers";

const shouldDump = process.env.MODELDEV_DUMP === "1";

describe("models.dev", () => {
	integrationTest("fetches and parses model metadata", async () => {
		const service = new ModelMetadataServiceImpl();
		const entries = await service.getAllModelEntries();
		const providerIds = Object.keys(entries);
		const models = providerIds.flatMap((providerId) =>
			Object.values(entries[providerId] ?? {}),
		);
		expect(providerIds.length).toBeGreaterThan(0);
		expect(models.length).toBeGreaterThan(0);
		expect(typeof models[0]?.modelId).toBe("string");
		expect(typeof models[0]?.provider).toBe("string");

		const firstProvider = providerIds[0];
		const providerEntries = await service.getModelEntries(firstProvider);
		expect(providerEntries).not.toBeNull();
		expect(providerEntries?.length ?? 0).toBeGreaterThan(0);

		// get openai gpt-5.2
		const openaiEntry = await service.getModelEntry("openai", "gpt-5.2");
		expect(openaiEntry).not.toBeNull();
		expect(openaiEntry?.modelId).toBe("gpt-5.2");
		expect(openaiEntry?.provider).toBe("openai");
		expect(openaiEntry?.cost).not.toBeNull();
		expect(openaiEntry?.limits).not.toBeNull();
		expect(openaiEntry?.limits?.contextWindow).toBeGreaterThan(0);
		expect(openaiEntry?.limits?.outputTokens).toBeGreaterThan(0);

		const openaiGpt52Entries = await service.getModelEntries("openai");
		expect(openaiGpt52Entries).not.toBeNull();
		expect(openaiGpt52Entries?.length ?? 0).toBeGreaterThan(0);
		expect(
			openaiGpt52Entries?.find((entry) => entry.modelId === "gpt-5.2")
				?.provider,
		).toBe("openai");

		if (shouldDump) {
			console.log(JSON.stringify(openaiGpt52Entries, null, 2));
		}

		// get anthropic
		const anthropicEntry = await service.getModelEntry(
			"anthropic",
			"claude-opus-4-5",
		);
		expect(anthropicEntry).not.toBeNull();
		expect(anthropicEntry?.modelId).toBe("claude-opus-4-5");
		expect(anthropicEntry?.provider).toBe("anthropic");
		expect(anthropicEntry?.cost).not.toBeNull();
		expect(anthropicEntry?.limits).not.toBeNull();
		expect(anthropicEntry?.limits?.contextWindow).toBeGreaterThan(0);
		expect(anthropicEntry?.limits?.outputTokens).toBeGreaterThan(0);

		const anthropicEntries = await service.getModelEntries("anthropic");
		expect(anthropicEntries).not.toBeNull();
		expect(anthropicEntries?.length ?? 0).toBeGreaterThan(0);
		expect(
			anthropicEntries?.find((entry) => entry.modelId === "claude-opus-4-5")
				?.provider,
		).toBe("anthropic");

		if (shouldDump) {
			console.log(JSON.stringify(anthropicEntries, null, 2));
		}
	});
});
