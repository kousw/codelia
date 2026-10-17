import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ResponsesProviderConfig } from "@codelia/config";
import { resolveModel } from "@codelia/core";
import { AuthResolver } from "../src/auth/resolver";
import { createRuntimeModel } from "../src/model-factory";
import { buildModelRegistry } from "../src/model-registry";
import { buildConfiguredModelRegistry } from "../src/responses-provider";
import { createModelHandlers, buildProviderModelList } from "../src/rpc/model";
import { RuntimeState } from "../src/runtime-state";
import { AgentTreeCoordinator } from "../src/subagents/coordinator";
import { createProcessSubagentFactory } from "../src/subagents/process-executor";
import { TaskManager } from "../src/tasks";
import { TaskRegistryStore } from "@codelia/storage";

const home: ResponsesProviderConfig = {
	type: "responses",
	base_url: "https://gateway.test/v1",
	api_key_env: "CODELIA_TEST_RESPONSES_KEY",
	retry: "off",
	models: {
		model: {
			context_window: 1000,
			supports_tools: true,
			supports_reasoning: true,
			reasoning_levels: ["low", "medium", "high"],
		},
	},
};

describe("configured Responses endpoints", () => {
	let root: string;
	const env = new Map<string, string | undefined>();
	const set = (name: string, value: string) => {
		if (!env.has(name)) env.set(name, process.env[name]);
		process.env[name] = value;
	};
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "codelia-responses-"));
		set("CODELIA_LAYOUT", "xdg");
		for (const kind of ["CONFIG", "CACHE", "DATA", "STATE"])
			set(`XDG_${kind}_HOME`, path.join(root, kind.toLowerCase()));
		set("CODELIA_TEST_RESPONSES_KEY", "test-home-key");
		set("OPENAI_API_KEY", "test-openai-key");
	});
	afterEach(async () => {
		for (const [name, value] of env) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		env.clear();
		await fs.rm(root, { recursive: true, force: true });
	});

	test("keeps auth separate and never falls back to OpenAI credentials", async () => {
		const resolver = await AuthResolver.create(new RuntimeState(), () => {}, {
			home,
			other: { ...home, api_key_env: undefined },
		});
		expect(await resolver.resolveProvider("home")).toBe("home");
		expect(await resolver.resolveProviderAuth("home")).toEqual({
			method: "api_key",
			api_key: "test-home-key",
		});
		expect(await resolver.resolveProviderAuth("openai")).toEqual({
			method: "api_key",
			api_key: "test-openai-key",
		});
		await expect(resolver.resolveProviderAuth("other")).rejects.toThrow(
			"UI does not support auth prompts",
		);
		await expect(resolver.resolveProvider("unregistered")).rejects.toThrow(
			"Unsupported",
		);
	});

	test("config models are scoped, authoritative, and require no metadata network", async () => {
		const providers = {
			home,
			local: { ...home, models: { model: { context_window: 32768 } } },
		};
		const { llm } = await createRuntimeModel({
			provider: "home",
			config: { name: "model", providers },
			auth: { method: "api_key", api_key: "test" },
			useMetadata: true,
			log: () => {},
		});
		let metadataCalls = 0;
		const registry = await buildModelRegistry(llm, {
			providers,
			metadataService: {
				async getAllModelEntries() {
					metadataCalls++;
					throw new Error("must not fetch");
				},
				async refreshAllModelEntries() {
					metadataCalls++;
					throw new Error("must not fetch");
				},
			},
		});
		expect(metadataCalls).toBe(0);
		expect(resolveModel(registry, "model", "home")?.contextWindow).toBe(1000);
		expect(resolveModel(registry, "model", "local")?.contextWindow).toBe(32768);
		expect(resolveModel(registry, "home/model", "local")).toBeUndefined();
		const list = await buildProviderModelList({
			provider: "home",
			providers,
			includeDetails: true,
			log: () => {},
		});
		expect(list.models).toEqual(["model"]);
		expect(list.details?.model.context_window).toBe(1000);
	});

	test("model RPCs list configured endpoints and reject unsupported choices before persistence", async () => {
		const state = new RuntimeState();
		state.setRuntimeEnvironment({
			environment: { preset: "embedded-no-local-tools" },
			adapters: {
				systemPromptProvider: { loadSystemPrompt: () => "test" },
				credentialProvider: {
					resolveProvider: async () => "home",
					resolveProviderAuth: async () => ({
						method: "api_key",
						api_key: "test",
					}),
				},
				eventSink: { emit: () => {} },
				toolProviders: [],
				configProvider: {
					resolveModelConfig: async () => ({
						provider: "home",
						name: "model",
						providers: { home },
					}),
				},
			},
		});
		const handlers = createModelHandlers({ state, log: () => {} });
		const messages: Array<{
			id: string;
			result?: Record<string, unknown>;
			error?: unknown;
		}> = [];
		const original = process.stdout.write;
		process.stdout.write = ((chunk: string | Uint8Array) => {
			messages.push(JSON.parse(String(chunk)));
			return true;
		}) as typeof process.stdout.write;
		try {
			await handlers.handleModelList("list", {
				provider: "home",
				include_details: true,
			});
			await handlers.handleModelSet("set", {
				provider: "home",
				name: "model",
				scope: "session",
				reasoning: "high",
			});
			await handlers.handleModelSet("bad-effort", {
				provider: "home",
				name: "model",
				scope: "session",
				reasoning: "max",
			});
			await handlers.handleModelSet("bad-model", {
				provider: "home",
				name: "missing",
				scope: "session",
			});
			await handlers.handleModelList("bad-provider", { provider: "missing" });
		} finally {
			process.stdout.write = original;
		}
		expect(messages[0].result).toMatchObject({
			provider: "home",
			models: ["model"],
			providers: expect.arrayContaining(["home"]),
			reasoning_levels: { model: ["low", "medium", "high"] },
		});
		expect(messages[1].error).toBeUndefined();
		expect(state.sessionModelOverride).toMatchObject({
			provider: "home",
			name: "model",
			reasoning: "high",
		});
		for (const msg of messages.slice(2)) expect(msg.error).toBeDefined();
	});

	test("a real child inherits a named endpoint and sends exactly one generation POST", async () => {
		let posts = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				expect(new URL(request.url).pathname).toBe("/v1/responses");
				expect(request.headers.get("authorization")).toBe(
					"Bearer test-home-key",
				);
				posts++;
				return Response.json(
					{ error: { code: "queue_full" } },
					{ status: 429 },
				);
			},
		});
		const tasks = new TaskManager({
			registry: new TaskRegistryStore(path.join(root, "tasks")),
		});
		const build = await Bun.build({
			entrypoints: [
				new URL("../src/subagents/child-entry.ts", import.meta.url).pathname,
			],
			target: "bun",
			outdir: root,
		});
		expect(build.success).toBe(true);
		const tree = new AgentTreeCoordinator(
			tasks,
			createProcessSubagentFactory({
				entry: path.join(root, "child-entry.js"),
			}),
		);
		tree.configure({
			workspace_root: root,
			approval_mode: "minimal",
			model: {
				provider: "openai",
				name: "gpt-5",
				providers: {
					home: { ...home, base_url: `http://127.0.0.1:${server.port}/v1` },
				},
			},
		});
		try {
			const task = await tree.spawn(
				{
					kind: "subagent",
					name: "GatewayProbe",
					prompt: "test",
					model: { provider: "home", name: "model" },
					workspace_access: "read-only",
					tool_allowlist: [],
					timeout_seconds: 10,
				},
				{ session_id: "owner" },
			);
			const terminal = await tasks.wait(task.task_id);
			expect(terminal.state).toBe("failed");
			expect(terminal.failure_message).toContain("queue_full");
			expect(posts).toBe(1);
		} finally {
			await tasks.shutdown();
			server.stop(true);
		}
	}, 20000);
});
