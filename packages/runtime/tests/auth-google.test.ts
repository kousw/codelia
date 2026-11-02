import { expect, test } from "bun:test";
import { SUPPORTED_PROVIDERS } from "../src/auth/resolver";
import { resolveImageRoute } from "../src/image-generation/route";
import { createRuntimeModel } from "../src/model-factory";

test("Google custom image route prefers stored key, then GOOGLE_API_KEY, then GEMINI_API_KEY", async () => {
	expect(SUPPORTED_PROVIDERS).toContain("google");
	const config = {
		mode: "custom" as const,
		provider: "google" as const,
		model: "gemini-nano-banana-2.1",
	};
	const env = (name: string) =>
		({
			GOOGLE_API_KEY: "primary-fixture",
			GEMINI_API_KEY: "secondary-fixture",
		})[name as "GOOGLE_API_KEY" | "GEMINI_API_KEY"];
	expect(
		await resolveImageRoute(config, {
			storedKey: async () => "stored-fixture",
			env,
		}),
	).toMatchObject({ apiKey: "stored-fixture" });
	expect(
		await resolveImageRoute(config, { storedKey: async () => undefined, env }),
	).toMatchObject({ apiKey: "primary-fixture" });
	expect(
		await resolveImageRoute(config, {
			storedKey: async () => undefined,
			env: (name) =>
				name === "GEMINI_API_KEY" ? "secondary-fixture" : undefined,
		}),
	).toMatchObject({ apiKey: "secondary-fixture" });
});

test("Google factory selects the static model and ignores inherited boolean Fast", async () => {
	const args = {
		provider: "google" as const,
		config: { name: "gemini-3.8-flash", reasoning: "xhigh" as const },
		auth: { method: "api_key" as const, api_key: "fixture" },
		useMetadata: false,
		log: () => {},
	};
	const result = await createRuntimeModel(args);
	expect(result.llm.provider).toBe("google");
	expect(result.resolvedModelName).toBe("gemini-3.8-flash");
	const inheritedFast = await createRuntimeModel({
		...args,
		config: { name: "gemini-4-argon", reasoning: "medium", fast: true },
	});
	expect(inheritedFast.resolvedModelName).toBe("gemini-4-argon");
	await expect(
		createRuntimeModel({
			...args,
			config: { ...args.config, fast: "ultrafast" },
		}),
	).rejects.toThrow("Ultrafast requires OpenAI");
});
