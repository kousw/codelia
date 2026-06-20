import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Agent, BaseChatModel } from "@codelia/core";
import { createAgentFactory } from "../src/agent-factory";
import { RuntimeState } from "../src/runtime-state";

describe("createAgentFactory Z.ai", () => {
	let tempRoot = "";
	const envSnapshot = new Map<string, string | undefined>();
	let originalFetch: typeof fetch;

	const setEnv = (key: string, value: string) => {
		if (!envSnapshot.has(key)) {
			envSnapshot.set(key, process.env[key]);
		}
		process.env[key] = value;
	};

	beforeEach(async () => {
		originalFetch = globalThis.fetch;
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codelia-zai-agent-"));
		setEnv("CODELIA_LAYOUT", "xdg");
		setEnv("XDG_STATE_HOME", path.join(tempRoot, "state"));
		setEnv("XDG_CACHE_HOME", path.join(tempRoot, "cache"));
		setEnv("XDG_CONFIG_HOME", path.join(tempRoot, "config-home"));
		setEnv("XDG_DATA_HOME", path.join(tempRoot, "data"));
		setEnv("ZAI_API_KEY", "test-zai-key");
		setEnv("ZAI_BASE_URL", "https://example.test/zai/v4");
		const configPath = path.join(tempRoot, "config.json");
		setEnv("CODELIA_CONFIG_PATH", configPath);
		await fs.writeFile(
			configPath,
			JSON.stringify(
				{
					version: 1,
					model: {
						provider: "zai",
						name: "glm-5.2",
						reasoning: "low",
					},
					search: {
						mode: "auto",
					},
					execution_environment: {
						startup_checks: {
							enabled: false,
						},
					},
				},
				null,
				2,
			),
			"utf8",
		);
		globalThis.fetch = Object.assign(
			async (input: Parameters<typeof fetch>[0]) => {
				const url = String(input);
				if (url === "https://models.dev/api.json") {
					return new Response(
						JSON.stringify({
							openai: {
								models: {
									"gpt-test": {
										id: "gpt-test",
										name: "GPT Test",
									},
								},
							},
						}),
						{
							status: 200,
							headers: { "content-type": "application/json" },
						},
					);
				}
				throw new Error(`unexpected fetch: ${url}`);
			},
			{ preconnect: originalFetch.preconnect },
		) as typeof fetch;
	});

	afterEach(async () => {
		globalThis.fetch = originalFetch;
		for (const [key, value] of envSnapshot) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
		envSnapshot.clear();
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	test("constructs ChatZai and uses local search for search.mode=auto", async () => {
		const projectDir = path.join(tempRoot, "project");
		await fs.mkdir(projectDir, { recursive: true });
		const state = new RuntimeState();
		state.runtimeWorkingDir = projectDir;
		state.runtimeSandboxRoot = projectDir;
		const getAgent = createAgentFactory(state);

		const agent = await getAgent();
		const llm = (agent as unknown as { llm: BaseChatModel }).llm;

		expect(llm.provider).toBe("zai");
		expect(llm.model).toBe("glm-5.2");
		expect(state.currentModelProvider).toBe("zai");
		expect(state.currentModelName).toBe("glm-5.2");
		expect(state.tools?.some((tool) => tool.name === "search")).toBe(true);
		expect(
			state.toolDefinitions?.some((tool) => tool.type === "hosted_search"),
		).toBe(false);
	});
});
