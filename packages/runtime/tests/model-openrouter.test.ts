import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildProviderModelList } from "../src/rpc/model";

const withTempStorageEnv = async () => {
	const tempRoot = await fs.mkdtemp(
		path.join(os.tmpdir(), "codelia-openrouter-model-"),
	);
	const snapshot = new Map<string, string | undefined>();
	const setEnv = (key: string, value: string) => {
		snapshot.set(key, process.env[key]);
		process.env[key] = value;
	};

	setEnv("CODELIA_LAYOUT", "xdg");
	setEnv("XDG_STATE_HOME", path.join(tempRoot, "state"));
	setEnv("XDG_CACHE_HOME", path.join(tempRoot, "cache"));
	setEnv("XDG_CONFIG_HOME", path.join(tempRoot, "config"));
	setEnv("XDG_DATA_HOME", path.join(tempRoot, "data"));

	return {
		async cleanup() {
			for (const [key, value] of snapshot) {
				if (value === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = value;
				}
			}
			await fs.rm(tempRoot, { recursive: true, force: true });
		},
	};
};

describe("model.list openrouter", () => {
	test("loads models from OpenRouter API with optional headers", async () => {
		const env = await withTempStorageEnv();
		const originalFetch = globalThis.fetch;
		const envRestore: Array<[string, string | undefined]> = [];
		const setEnv = (key: string, value: string) => {
			envRestore.push([key, process.env[key]]);
			process.env[key] = value;
		};
		const calls: Array<{ url: string; headers: Headers }> = [];
		setEnv("OPENROUTER_API_KEY", "sk-or-test");
		setEnv("OPENROUTER_HTTP_REFERER", "https://example.app");
		setEnv("OPENROUTER_X_TITLE", "Codelia Test");

		globalThis.fetch = (async (
			input: URL | RequestInfo,
			init?: RequestInit,
		): Promise<Response> => {
			const url =
				typeof input === "string"
					? input
					: input instanceof URL
						? input.toString()
						: input.url;
			calls.push({
				url,
				headers: new Headers(init?.headers ?? {}),
			});
			return new Response(
				JSON.stringify({
					data: [
						{
							id: "anthropic/claude-sonnet-4.5",
							created: 1700000000,
							context_length: 200000,
							top_provider: { max_completion_tokens: 8000 },
						},
						{
							id: "openai/gpt-5",
							created: 1800000000,
							context_length: 400000,
							top_provider: { max_completion_tokens: 16000 },
						},
					],
				}),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			);
		}) as typeof fetch;

		try {
			const result = await buildProviderModelList({
				provider: "openrouter",
				includeDetails: true,
				log: () => {},
			});

			expect(result.models).toEqual([
				"openai/gpt-5",
				"anthropic/claude-sonnet-4.5",
			]);
			expect(result.details?.["openai/gpt-5"]).toEqual({
				release_date: "2027-01-15",
				context_window: 400000,
				max_input_tokens: 400000,
				max_output_tokens: 16000,
			});
			expect(result.details?.["anthropic/claude-sonnet-4.5"]).toEqual({
				release_date: "2023-11-14",
				context_window: 200000,
				max_input_tokens: 200000,
				max_output_tokens: 8000,
			});
			expect(calls).toHaveLength(1);
			expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/models");
			expect(calls[0]?.headers.get("authorization")).toBe(
				"Bearer sk-or-test",
			);
			expect(calls[0]?.headers.get("http-referer")).toBe(
				"https://example.app",
			);
			expect(calls[0]?.headers.get("x-title")).toBe("Codelia Test");
		} finally {
			for (const [key, value] of envRestore.reverse()) {
				if (value === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = value;
				}
			}
			globalThis.fetch = originalFetch;
			await env.cleanup();
		}
	});
});
