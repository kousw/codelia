import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ModelMetadataServiceImpl } from "../src/service";
import { ModelDevSource } from "../src/sources/modeldev";

const MODEL_DEV_PAYLOAD = {
	openai: {
		models: {
			"gpt-5": {
				id: "gpt-5",
				name: "GPT-5",
				limit: { context: 200_000, input: 100_000, output: 8_000 },
				cost: { input: 0.5, output: 1.5 },
			},
		},
	},
};

const restoreFetch: Array<typeof globalThis.fetch> = [];
const mockFetch = (payload: unknown) => {
	restoreFetch.push(globalThis.fetch);
	globalThis.fetch = async () =>
		new Response(JSON.stringify(payload), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
};

afterEach(() => {
	const original = restoreFetch.pop();
	if (original) {
		globalThis.fetch = original;
	}
});

describe("@codelia/model-metadata", () => {
	test("ModelDevSource loads provider entries from models.dev payload", async () => {
		mockFetch(MODEL_DEV_PAYLOAD);
		const root = await mkdtemp(path.join(os.tmpdir(), "codelia-model-meta-"));
		try {
			const source = new ModelDevSource({
				cachePath: path.join(root, "models.dev.json"),
				storageRoot: root,
			});
			await source.loadModelMetadata({ forceRefresh: true });
			const entry = await source.getModelEntry("openai", "gpt-5");

			expect(entry?.provider).toBe("openai");
			expect(entry?.modelId).toBe("gpt-5");
			expect(entry?.limits?.contextWindow).toBe(200000);
			expect(entry?.cost?.input).toBe(0.5);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("ModelMetadataServiceImpl refreshAllModelEntries returns merged index", async () => {
		mockFetch(MODEL_DEV_PAYLOAD);
		const root = await mkdtemp(path.join(os.tmpdir(), "codelia-model-meta-"));
		try {
			const service = new ModelMetadataServiceImpl({
				cachePath: path.join(root, "models.dev.json"),
				storageRoot: root,
			});
			const all = await service.refreshAllModelEntries();

			expect(all.openai?.["gpt-5"]?.modelId).toBe("gpt-5");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
