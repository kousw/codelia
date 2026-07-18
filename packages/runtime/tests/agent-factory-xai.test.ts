import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BaseChatModel } from "@codelia/core";
import { createAgentFactory } from "../src/agent-factory";
import { RuntimeState } from "../src/runtime-state";

describe("createAgentFactory xAI", () => {
	let tempRoot = "";
	const envSnapshot = new Map<string, string | undefined>();
	let originalFetch: typeof fetch;

	const setEnv = (key: string, value: string) => {
		if (!envSnapshot.has(key)) envSnapshot.set(key, process.env[key]);
		process.env[key] = value;
	};

	beforeEach(async () => {
		originalFetch = globalThis.fetch;
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codelia-xai-agent-"));
		setEnv("CODELIA_LAYOUT", "xdg");
		setEnv("XDG_STATE_HOME", path.join(tempRoot, "state"));
		setEnv("XDG_CACHE_HOME", path.join(tempRoot, "cache"));
		setEnv("XDG_CONFIG_HOME", path.join(tempRoot, "config-home"));
		setEnv("XDG_DATA_HOME", path.join(tempRoot, "data"));
		setEnv("XAI_API_KEY", "test-xai-key");
		setEnv("XAI_BASE_URL", "https://example.test/xai/v1");
		const configPath = path.join(tempRoot, "config.json");
		setEnv("CODELIA_CONFIG_PATH", configPath);
		await fs.writeFile(
			configPath,
			JSON.stringify({
				version: 1,
				model: { provider: "xai", name: "grok-4.5", reasoning: "max" },
				search: { mode: "auto" },
				execution_environment: { startup_checks: { enabled: false } },
			}),
			"utf8",
		);
		globalThis.fetch = Object.assign(
			async (input: Parameters<typeof fetch>[0]) => {
				if (String(input) === "https://models.dev/api.json") {
					return new Response(
						JSON.stringify({
							openai: {
								models: {
									"gpt-test": { id: "gpt-test", name: "GPT Test" },
								},
							},
						}),
						{
							status: 200,
							headers: { "content-type": "application/json" },
						},
					);
				}
				throw new Error(`unexpected fetch: ${String(input)}`);
			},
			{ preconnect: originalFetch.preconnect },
		) as typeof fetch;
	});

	afterEach(async () => {
		globalThis.fetch = originalFetch;
		for (const [key, value] of envSnapshot) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		envSnapshot.clear();
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	test("constructs ChatXai and selects native web search", async () => {
		const projectDir = path.join(tempRoot, "project");
		await fs.mkdir(projectDir, { recursive: true });
		const state = new RuntimeState();
		state.runtimeWorkingDir = projectDir;
		state.runtimeSandboxRoot = projectDir;

		const agent = await createAgentFactory(state)();
		const llm = (agent as unknown as { llm: BaseChatModel }).llm;

		expect(llm.provider).toBe("xai");
		expect(llm.model).toBe("grok-4.5");
		expect(state.currentModelProvider).toBe("xai");
		expect(state.currentModelName).toBe("grok-4.5");
		expect(state.tools?.some((tool) => tool.name === "search")).toBe(false);
		expect(state.toolDefinitions).toContainEqual(
			expect.objectContaining({
				type: "hosted_search",
				name: "web_search",
				provider: "xai",
			}),
		);
	});
});
