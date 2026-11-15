import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
	Agent,
	BaseMessage,
	SessionState,
	SessionStateStore,
} from "@codelia/core";
import type { RpcMessage, RpcRequest, RpcResponse } from "@codelia/protocol";
import { RPC_ERROR_CODE } from "@codelia/protocol";
import { createRuntimeHandlers } from "../src/rpc/handlers";
import { RuntimeState } from "../src/runtime-state";

const TEST_TIMEOUT_MS = 5_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

const isRpcMessage = (value: unknown): value is RpcMessage =>
	isRecord(value) && value.jsonrpc === "2.0";

const isRpcResponse = (value: unknown): value is RpcResponse =>
	isRpcMessage(value) && "id" in value && !("method" in value);

const waitFor = async (
	condition: () => boolean,
	timeoutMs = TEST_TIMEOUT_MS,
): Promise<void> => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) return;
		await Bun.sleep(20);
	}
	throw new Error("Timed out waiting for condition");
};

const createStdoutCapture = () => {
	const originalWrite = process.stdout.write.bind(process.stdout);
	let buffer = "";
	const messages: RpcMessage[] = [];

	const write = (chunk: string | Uint8Array): boolean => {
		const text =
			typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		buffer += text;
		let idx = buffer.indexOf("\n");
		while (idx >= 0) {
			const line = buffer.slice(0, idx).trim();
			buffer = buffer.slice(idx + 1);
			if (line) {
				try {
					const parsed = JSON.parse(line) as unknown;
					if (isRpcMessage(parsed)) {
						messages.push(parsed);
					}
				} catch {
					// ignore non-JSON lines
				}
			}
			idx = buffer.indexOf("\n");
		}
		return true;
	};

	return {
		start() {
			process.stdout.write = write;
		},
		stop() {
			process.stdout.write = originalWrite;
		},
		async waitForResponse(id: string): Promise<RpcResponse> {
			let result: RpcResponse | undefined;
			await waitFor(() => {
				result = messages.find(
					(msg): msg is RpcResponse => isRpcResponse(msg) && msg.id === id,
				);
				return !!result;
			});
			if (!result) {
				throw new Error(`response not found: ${id}`);
			}
			return result;
		},
	};
};

const withTempEnv = async () => {
	const tempRoot = await fs.mkdtemp(
		path.join(os.tmpdir(), "codelia-model-sync-"),
	);
	const envSnapshot = new Map<string, string | undefined>();
	const setEnv = (key: string, value: string) => {
		envSnapshot.set(key, process.env[key]);
		process.env[key] = value;
	};

	setEnv("HOME", tempRoot);
	setEnv("CODELIA_LAYOUT", "xdg");
	setEnv("XDG_STATE_HOME", path.join(tempRoot, "state"));
	setEnv("XDG_CACHE_HOME", path.join(tempRoot, "cache"));
	setEnv("XDG_CONFIG_HOME", path.join(tempRoot, "config-home"));
	setEnv("XDG_DATA_HOME", path.join(tempRoot, "data"));

	const configPath = path.join(tempRoot, "config.json");
	setEnv("CODELIA_CONFIG_PATH", configPath);
	await fs.mkdir(path.dirname(configPath), { recursive: true });
	await fs.writeFile(
		configPath,
		JSON.stringify(
			{
				version: 1,
				model: {
					provider: "openai",
					name: "gpt-5",
				},
			},
			null,
			2,
		),
		"utf8",
	);

	const projectDir = path.join(tempRoot, "project");
	await fs.mkdir(projectDir, { recursive: true });

	return {
		projectDir,
		configPath,
		async cleanup() {
			for (const [key, value] of envSnapshot) {
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

const createSessionState = (
	sessionId: string,
	meta?: Record<string, unknown>,
): SessionState => ({
	schema_version: 1,
	session_id: sessionId,
	updated_at: new Date().toISOString(),
	messages: [],
	meta,
});

const createSessionStateStore = (
	map: Map<string, SessionState>,
): SessionStateStore => ({
	load: async (sessionId) => map.get(sessionId) ?? null,
	save: async (state) => {
		map.set(state.session_id, state);
	},
	list: async () => [],
});

const createInstantAgent = (): Agent => {
	let messages: BaseMessage[] = [];
	const runStream = async function* () {
		yield { type: "final" as const, content: "ok" };
	};
	const mock = {
		runStream,
		getContextLeftPercent: () => null,
		getUsageSummary: () => ({
			total_calls: 0,
			total_tokens: 0,
			total_input_tokens: 0,
			total_output_tokens: 0,
			total_cached_input_tokens: 0,
			total_cache_creation_tokens: 0,
			by_model: {},
		}),
		getHistoryMessages: () => messages,
		replaceHistoryMessages: (next: BaseMessage[]) => {
			messages = next;
		},
	};
	return mock as unknown as Agent;
};

describe("model state sync", () => {
	test.each([
		["config", "google", "Google", "gemini-4-argon", "gemini-4-argon"],
		["session", "google", "Google", "gemini-4-argon", "gemini-4-argon"],
		["config", "deepseek", "DeepSeek", "deepseek-flash", "deepseek-flash"],
		["session", "deepseek", "DeepSeek", "deepseek-v4-pro", "deepseek-v4-pro"],
		["config", "deepseek", "DeepSeek", "default", "deepseek-flash"],
		["session", "deepseek", "DeepSeek", "default", "deepseek-flash"],
	] as const)(
		"%s %s selection clears inherited Fast and rejects explicit Fast before writes",
		async (scope, provider, label, model, expectedModel) => {
			const capture = createStdoutCapture();
			const state = new RuntimeState();
			let writes = 0;
			let config: import("../src/config").ResolvedModelConfig = {
				provider: "openai",
				name: "gpt-6.1-sol",
				fast: true,
			};
			state.setRuntimeEnvironment({
				environment: { preset: "embedded-no-local-tools" },
				adapters: {
					systemPromptProvider: { loadSystemPrompt: () => "test" },
					eventSink: { emit: () => {} },
					toolProviders: [],
					configProvider: {
						resolveModelConfig: async () => config,
						updateModel: async (_cwd, next) => {
							writes++;
							config = { ...config, ...next };
							return { scope: "global", path: "/host/config" };
						},
					},
					credentialProvider: {
						resolveProvider: async () => provider,
						resolveProviderAuth: async () => ({
							method: "api_key",
							api_key: "fixture",
						}),
					},
				},
			});
			const handlers = createRuntimeHandlers({
				state,
				getAgent: async () => ({}) as Agent,
				log: () => {},
			});
			const setModel = async (id: string, fast?: boolean) => {
				handlers.processMessage({
					jsonrpc: "2.0",
					id,
					method: "model.set",
					params: {
						provider: provider,
						name: model,
						scope,
						...(fast !== undefined ? { fast } : {}),
					},
				} satisfies RpcRequest);
				return capture.waitForResponse(id);
			};
			capture.start();
			try {
				const explicit = await setModel("google-explicit-fast", true);
				expect(explicit.error).toMatchObject({
					code: RPC_ERROR_CODE.INVALID_PARAMS,
					message: expect.stringContaining(
						`${label} models do not support Fast`,
					),
				});
				expect(writes).toBe(0);
				expect(state.sessionModelOverride).toBeNull();

				const inherited = await setModel("google-inherited-fast");
				expect(inherited.error).toBeUndefined();
				expect(state.currentModelName).toBe(expectedModel);
				expect(inherited.result).toMatchObject({
					provider,
					name: expectedModel,
					fast: false,
					source: scope,
				});
				if (scope === "config") {
					expect(writes).toBe(1);
					expect(config).toMatchObject({
						provider,
						name: expectedModel,
						fast: false,
					});
				} else {
					expect(writes).toBe(0);
					expect(state.sessionModelOverride).toMatchObject({
						provider,
						name: expectedModel,
						fast: false,
					});
				}
			} finally {
				capture.stop();
			}
		},
	);

	test("model.set keeps current model identity in runtime state before the next run", async () => {
		const env = await withTempEnv();
		const capture = createStdoutCapture();
		capture.start();
		try {
			const state = new RuntimeState();
			state.lastUiContext = {
				cwd: env.projectDir,
				workspace_root: env.projectDir,
			};
			state.runtimeWorkingDir = env.projectDir;
			state.currentModelProvider = "openai";
			state.currentModelName = "gpt-5";
			state.agent = {} as Agent;
			const handlers = createRuntimeHandlers({
				state,
				getAgent: async () => ({}) as Agent,
				log: () => {},
			});

			handlers.processMessage({
				jsonrpc: "2.0",
				id: "model-set-sync-1",
				method: "model.set",
				params: {
					provider: "openai",
					name: "gpt-5.3-codex",
				},
			} satisfies RpcRequest);
			const response = await capture.waitForResponse("model-set-sync-1");
			expect((response as { error?: unknown }).error).toBeUndefined();
			expect(response.result).toMatchObject({
				provider: "openai",
				name: "gpt-5.3-codex",
				source: "config",
			});
			expect(state.currentModelProvider).toBe("openai");
			expect(state.currentModelName).toBe("gpt-5.3-codex");
			expect(state.agent).toBeNull();
		} finally {
			capture.stop();
			await env.cleanup();
		}
	});

	test("model.set accepts known Z.ai model and rejects unknown Z.ai model", async () => {
		const env = await withTempEnv();
		const capture = createStdoutCapture();
		capture.start();
		try {
			const state = new RuntimeState();
			state.lastUiContext = {
				cwd: env.projectDir,
				workspace_root: env.projectDir,
			};
			state.runtimeWorkingDir = env.projectDir;
			state.agent = {} as Agent;
			const handlers = createRuntimeHandlers({
				state,
				getAgent: async () => ({}) as Agent,
				log: () => {},
			});

			handlers.processMessage({
				jsonrpc: "2.0",
				id: "model-set-zai-ok",
				method: "model.set",
				params: {
					provider: "zai",
					name: "glm-5.2",
				},
			} satisfies RpcRequest);
			const okResponse = await capture.waitForResponse("model-set-zai-ok");
			expect((okResponse as { error?: unknown }).error).toBeUndefined();
			expect(okResponse.result).toMatchObject({
				provider: "zai",
				name: "glm-5.2",
			});
			expect(state.currentModelProvider).toBe("zai");
			expect(state.currentModelName).toBe("glm-5.2");

			handlers.processMessage({
				jsonrpc: "2.0",
				id: "model-set-zai-51-ok",
				method: "model.set",
				params: {
					provider: "zai",
					name: "glm-5.1",
				},
			} satisfies RpcRequest);
			const ok51Response = await capture.waitForResponse("model-set-zai-51-ok");
			expect((ok51Response as { error?: unknown }).error).toBeUndefined();
			expect(ok51Response.result).toMatchObject({
				provider: "zai",
				name: "glm-5.1",
			});
			expect(state.currentModelProvider).toBe("zai");
			expect(state.currentModelName).toBe("glm-5.1");

			handlers.processMessage({
				jsonrpc: "2.0",
				id: "model-set-zai-bad",
				method: "model.set",
				params: {
					provider: "zai",
					name: "glm-next",
				},
			} satisfies RpcRequest);
			const badResponse = await capture.waitForResponse("model-set-zai-bad");
			expect(
				(badResponse as { error?: { message?: string } }).error?.message,
			).toBe("unknown model: glm-next");
		} finally {
			capture.stop();
			await env.cleanup();
		}
	});

	test("model.set can switch models for the current session without writing config", async () => {
		const env = await withTempEnv();
		const capture = createStdoutCapture();
		capture.start();
		try {
			const state = new RuntimeState();
			state.lastUiContext = {
				cwd: env.projectDir,
				workspace_root: env.projectDir,
			};
			state.runtimeWorkingDir = env.projectDir;
			state.currentModelProvider = "openai";
			state.currentModelName = "gpt-5";
			const handlers = createRuntimeHandlers({
				state,
				getAgent: async () => ({}) as Agent,
				log: () => {},
			});

			handlers.processMessage({
				jsonrpc: "2.0",
				id: "model-session-set-1",
				method: "model.set",
				params: {
					provider: "openai",
					name: "gpt-5.3-codex",
					reasoning: "high",
					scope: "session",
				},
			} satisfies RpcRequest);
			const sessionResponse = await capture.waitForResponse(
				"model-session-set-1",
			);
			expect((sessionResponse as { error?: unknown }).error).toBeUndefined();
			expect(sessionResponse.result).toMatchObject({
				provider: "openai",
				name: "gpt-5.3-codex",
				reasoning: "high",
				source: "session",
			});
			expect(state.currentModelProvider).toBe("openai");
			expect(state.currentModelName).toBe("gpt-5.3-codex");
			expect(state.currentModelSource).toBe("session");

			const storedConfig = JSON.parse(
				await fs.readFile(env.configPath, "utf8"),
			) as { model?: { name?: string } };
			expect(storedConfig.model?.name).toBe("gpt-5");

			handlers.processMessage({
				jsonrpc: "2.0",
				id: "model-session-list-1",
				method: "model.list",
				params: {
					provider: "openai",
				},
			} satisfies RpcRequest);
			const listResponse = await capture.waitForResponse(
				"model-session-list-1",
			);
			expect(listResponse.result).toMatchObject({
				provider: "openai",
				current: "gpt-5.3-codex",
				reasoning: "high",
				source: "session",
			});

			handlers.processMessage({
				jsonrpc: "2.0",
				id: "model-session-reset-1",
				method: "model.set",
				params: {
					scope: "session",
					reset: true,
				},
			} satisfies RpcRequest);
			const resetResponse = await capture.waitForResponse(
				"model-session-reset-1",
			);
			expect(resetResponse.result).toMatchObject({
				provider: "openai",
				name: "gpt-5",
				source: "config",
			});
			expect(state.currentModelProvider).toBe("openai");
			expect(state.currentModelName).toBe("gpt-5");
			expect(state.currentModelSource).toBe("config");
			expect(state.sessionModelOverride).toBeNull();
		} finally {
			capture.stop();
			await env.cleanup();
		}
	});

	test("model.set persists current-session model override in session state", async () => {
		const env = await withTempEnv();
		const capture = createStdoutCapture();
		const sessionStates = new Map<string, SessionState>();
		sessionStates.set(
			"session-a",
			createSessionState("session-a", { existing: true }),
		);
		capture.start();
		try {
			const state = new RuntimeState();
			state.sessionId = "session-a";
			state.sessionMeta = { existing: true };
			state.lastUiContext = {
				cwd: env.projectDir,
				workspace_root: env.projectDir,
			};
			state.runtimeWorkingDir = env.projectDir;
			const handlers = createRuntimeHandlers({
				state,
				getAgent: async () => ({}) as Agent,
				log: () => {},
				sessionStateStore: createSessionStateStore(sessionStates),
			});

			handlers.processMessage({
				jsonrpc: "2.0",
				id: "model-session-persist-1",
				method: "model.set",
				params: {
					provider: "openai",
					name: "gpt-5.3-codex",
					scope: "session",
					fast: true,
				},
			} satisfies RpcRequest);
			const response = await capture.waitForResponse("model-session-persist-1");
			expect((response as { error?: unknown }).error).toBeUndefined();
			expect(sessionStates.get("session-a")?.meta).toMatchObject({
				existing: true,
				codelia_model_override: {
					provider: "openai",
					name: "gpt-5.3-codex",
					fast: true,
				},
			});

			handlers.processMessage({
				jsonrpc: "2.0",
				id: "model-session-persist-reset-1",
				method: "model.set",
				params: {
					scope: "session",
					reset: true,
				},
			} satisfies RpcRequest);
			const resetResponse = await capture.waitForResponse(
				"model-session-persist-reset-1",
			);
			expect((resetResponse as { error?: unknown }).error).toBeUndefined();
			expect(sessionStates.get("session-a")?.meta).toEqual({ existing: true });
		} finally {
			capture.stop();
			await env.cleanup();
		}
	});

	test("run.start restores persisted session model override before creating agent", async () => {
		const env = await withTempEnv();
		const capture = createStdoutCapture();
		const sessionStates = new Map<string, SessionState>();
		sessionStates.set(
			"session-b",
			createSessionState("session-b", {
				codelia_model_override: {
					provider: "openai",
					name: "gpt-5.3-codex",
					reasoning: "high",
				},
			}),
		);
		let overrideAtAgentCreation: unknown;
		capture.start();
		try {
			const state = new RuntimeState();
			state.lastUiContext = {
				cwd: env.projectDir,
				workspace_root: env.projectDir,
			};
			state.runtimeWorkingDir = env.projectDir;
			const handlers = createRuntimeHandlers({
				state,
				getAgent: async () => {
					overrideAtAgentCreation = state.sessionModelOverride;
					return createInstantAgent();
				},
				log: () => {},
				sessionStateStore: createSessionStateStore(sessionStates),
			});

			handlers.processMessage({
				jsonrpc: "2.0",
				id: "run-restore-model-1",
				method: "run.start",
				params: {
					session_id: "session-b",
					input: { type: "text", text: "hello" },
				},
			} satisfies RpcRequest);
			const response = await capture.waitForResponse("run-restore-model-1");
			expect((response as { error?: unknown }).error).toBeUndefined();
			expect(overrideAtAgentCreation).toEqual({
				provider: "openai",
				name: "gpt-5.3-codex",
				reasoning: "high",
			});
			await waitFor(
				() =>
					sessionStates.get("session-b")?.meta?.codelia_model_override !==
					undefined,
			);
		} finally {
			capture.stop();
			await env.cleanup();
		}
	});
});

test.each(["config", "session"] as const)(
	"Ultrafast %s selection rejects unsupported requests before mutation and survives round-trip",
	async (scope) => {
		const capture = createStdoutCapture();
		const state = new RuntimeState();
		const sessionStates = new Map<string, SessionState>([
			["ultrafast", createSessionState("ultrafast", { existing: true })],
		]);
		let writes = 0;
		let method: "api_key" | "oauth" = "oauth";
		let config: import("../src/config").ResolvedModelConfig = {
			provider: "openai",
			name: "gpt-6.1-sol",
			fast: false,
		};
		state.setRuntimeEnvironment({
			environment: { preset: "embedded-no-local-tools" },
			adapters: {
				systemPromptProvider: { loadSystemPrompt: () => "test" },
				eventSink: { emit: () => {} },
				toolProviders: [],
				configProvider: {
					resolveModelConfig: async () => config,
					updateModel: async (_cwd, next) => {
						writes++;
						config = { ...config, ...next };
						return { scope: "global", path: "/host/config" };
					},
				},
				credentialProvider: {
					resolveProvider: async () => "openai",
					resolveProviderAuth: async () =>
						method === "api_key"
							? { method: "api_key", api_key: "test" }
							: {
									method: "oauth",
									oauth: {
										access_token: "test",
										refresh_token: "test",
										expires_at: 0,
									},
								},
				},
			},
		});
		state.sessionId = "ultrafast";
		const handlers = createRuntimeHandlers({
			state,
			getAgent: async () => ({}) as Agent,
			log: () => {},
			sessionStateStore: createSessionStateStore(sessionStates),
		});
		const set = async (id: string, name: string, fast: unknown) => {
			handlers.processMessage({
				jsonrpc: "2.0",
				id,
				method: "model.set",
				params: { provider: "openai", name, fast, scope },
			} as RpcRequest);
			return capture.waitForResponse(id);
		};
		capture.start();
		try {
			for (const [id, name, fast] of [
				["wrong-model", "gpt-6-sol", "ultrafast"],
				["wrong-value", "gpt-6.1-sol", "ultra"],
				["oauth", "gpt-6.1-sol", "ultrafast"],
			]) {
				expect((await set(id, name, fast)).error).toBeDefined();
				expect(writes).toBe(0);
				expect(state.sessionModelOverride).toBeNull();
				expect(sessionStates.get("ultrafast")?.meta).toEqual({
					existing: true,
				});
			}
			method = "api_key";
			const response = await set("enable", "gpt-6.1-sol", "ultrafast");
			expect(response.error).toBeUndefined();
			expect(response.result).toMatchObject({
				provider: "openai",
				name: "gpt-6.1-sol",
				fast: "ultrafast",
				source: scope,
			});
			if (scope === "config") {
				expect(config.fast).toBe("ultrafast");
				expect(writes).toBe(1);
			} else {
				expect(writes).toBe(0);
				const { readSessionModelOverride } = await import(
					"../src/effective-model"
				);
				expect(
					readSessionModelOverride(sessionStates.get("ultrafast")?.meta),
				).toMatchObject({ fast: "ultrafast" });
			}
			handlers.processMessage({
				jsonrpc: "2.0",
				id: "list",
				method: "model.list",
				params: { provider: "openai" },
			} satisfies RpcRequest);
			expect((await capture.waitForResponse("list")).result).toMatchObject({
				fast: "ultrafast",
			});
			const disabled = await set("disable", "gpt-6.1-sol", false);
			expect(disabled.result).toMatchObject({ fast: false });
			if (scope === "session") {
				// Reset must admit the persistent target before discarding this
				// usable session override after credentials have changed.
				config = { ...config, name: "gpt-6-astra", fast: "ultrafast" };
				method = "oauth";
				const overrideBefore = state.sessionModelOverride;
				const metaBefore = state.sessionMeta;
				const savedBefore = sessionStates.get("ultrafast");
				const agentBefore = {} as Agent;
				state.agent = agentBefore;
				const reset = async (id: string) => {
					handlers.processMessage({
						jsonrpc: "2.0",
						id,
						method: "model.set",
						params: { scope: "session", reset: true },
					} satisfies RpcRequest);
					return capture.waitForResponse(id);
				};
				expect((await reset("reset-oauth")).error).toMatchObject({
					code: RPC_ERROR_CODE.INVALID_PARAMS,
					message: expect.stringContaining(
						"requires OpenAI API-key authentication",
					),
				});
				expect(state.sessionModelOverride).toBe(overrideBefore);
				expect(state.sessionModelOverride?.fast).toBe(false);
				expect(state.sessionMeta).toBe(metaBefore);
				expect(sessionStates.get("ultrafast")).toBe(savedBefore);
				expect(state.currentModelName).toBe("gpt-6.1-sol");
				expect(state.currentModelSource).toBe("session");
				expect(state.agent).toBe(agentBefore);
				method = "api_key";
				const resetResult = await reset("reset-api-key");
				expect(resetResult.error).toBeUndefined();
				expect(resetResult.result).toMatchObject({
					name: "gpt-6-astra",
					source: "config",
					fast: "ultrafast",
				});
				expect(state.sessionModelOverride).toBeNull();
				expect(state.agent).toBeNull();
				expect(sessionStates.get("ultrafast")?.meta).toEqual({
					existing: true,
				});
				expect(writes).toBe(0);
			}
		} finally {
			capture.stop();
		}
	},
);

describe("session model override set before the session is resumed", () => {
	const SAVED_OVERRIDE = {
		provider: "openai",
		name: "gpt-5.3-codex",
		reasoning: "high",
	};

	const createResumeHarness = (sessionStates: Map<string, SessionState>) => {
		const capture = createStdoutCapture();
		const startRuntime = (projectDir: string) => {
			const state = new RuntimeState();
			state.lastUiContext = { cwd: projectDir, workspace_root: projectDir };
			state.runtimeWorkingDir = projectDir;
			const observed: {
				overrideAtAgentCreation?: unknown;
				metaAtRunStart?: Record<string, unknown>;
			} = {};
			const handlers = createRuntimeHandlers({
				state,
				getAgent: async () => {
					observed.overrideAtAgentCreation = state.sessionModelOverride;
					const agent = createInstantAgent();
					const runStream = agent.runStream.bind(agent);
					// Snapshot the store once the session is bound, before the
					// run's own end-of-run save.
					agent.runStream = ((...args: Parameters<Agent["runStream"]>) => {
						observed.metaAtRunStart = state.sessionId
							? sessionStates.get(state.sessionId)?.meta
							: undefined;
						return runStream(...args);
					}) as Agent["runStream"];
					return agent;
				},
				log: () => {},
				sessionStateStore: createSessionStateStore(sessionStates),
			});
			let seq = 0;
			const request = async (
				method: RpcRequest["method"],
				params: unknown,
			): Promise<RpcResponse> => {
				const id = `${method}-${++seq}-${crypto.randomUUID()}`;
				handlers.processMessage({
					jsonrpc: "2.0",
					id,
					method,
					params,
				} as RpcRequest);
				return capture.waitForResponse(id);
			};
			const runAndWait = async (sessionId: string) => {
				const response = await request("run.start", {
					session_id: sessionId,
					input: { type: "text", text: "hello" },
				});
				expect(response.error).toBeUndefined();
				await waitFor(() => state.activeRunId === null);
				return response;
			};
			return { state, observed, request, runAndWait };
		};
		return { capture, startRuntime };
	};

	const savedSession = (sessionId: string) =>
		createSessionState(sessionId, {
			existing: true,
			codelia_model_override: SAVED_OVERRIDE,
		});

	test("model.set before resume wins over the saved override and is saved to that session", async () => {
		const env = await withTempEnv();
		const sessionStates = new Map([["saved", savedSession("saved")]]);
		const { capture, startRuntime } = createResumeHarness(sessionStates);
		capture.start();
		try {
			const first = startRuntime(env.projectDir);
			const selected = await first.request("model.set", {
				provider: "openai",
				name: "gpt-5.4",
				reasoning: "low",
				scope: "session",
			});
			expect(selected.error).toBeUndefined();
			expect(selected.result).toMatchObject({
				name: "gpt-5.4",
				source: "session",
			});
			// Not bound yet: nothing is written to any session.
			expect(sessionStates.get("saved")?.meta?.codelia_model_override).toEqual(
				SAVED_OVERRIDE,
			);

			await first.runAndWait("saved");
			const expected = {
				provider: "openai",
				name: "gpt-5.4",
				reasoning: "low",
			};
			expect(first.observed.overrideAtAgentCreation).toMatchObject(expected);
			expect(first.state.sessionModelOverride).toMatchObject(expected);
			expect(first.state.currentModelName).toBe("gpt-5.4");
			expect(first.observed.metaAtRunStart).toMatchObject({
				existing: true,
				codelia_model_override: expected,
			});
			expect(sessionStates.get("saved")?.meta).toMatchObject({
				existing: true,
				codelia_model_override: expected,
			});

			const second = startRuntime(env.projectDir);
			await second.runAndWait("saved");
			expect(second.observed.overrideAtAgentCreation).toMatchObject(expected);
		} finally {
			capture.stop();
			await env.cleanup();
		}
	});

	test("reset before resume clears the saved override", async () => {
		const env = await withTempEnv();
		const sessionStates = new Map([["saved", savedSession("saved")]]);
		const { capture, startRuntime } = createResumeHarness(sessionStates);
		capture.start();
		try {
			const first = startRuntime(env.projectDir);
			const reset = await first.request("model.set", {
				scope: "session",
				reset: true,
			});
			expect(reset.error).toBeUndefined();
			expect(reset.result).toMatchObject({ name: "gpt-5", source: "config" });

			await first.runAndWait("saved");
			expect(first.observed.overrideAtAgentCreation).toBeNull();
			expect(first.state.sessionModelOverride).toBeNull();
			expect(first.observed.metaAtRunStart).toEqual({ existing: true });
			expect(
				sessionStates.get("saved")?.meta?.codelia_model_override,
			).toBeUndefined();

			const second = startRuntime(env.projectDir);
			await second.runAndWait("saved");
			expect(second.observed.overrideAtAgentCreation).toBeNull();
		} finally {
			capture.stop();
			await env.cleanup();
		}
	});

	test("resume without a prior model.set restores the saved override", async () => {
		const env = await withTempEnv();
		const sessionStates = new Map([["saved", savedSession("saved")]]);
		const { capture, startRuntime } = createResumeHarness(sessionStates);
		capture.start();
		try {
			const runtime = startRuntime(env.projectDir);
			await runtime.runAndWait("saved");
			expect(runtime.observed.overrideAtAgentCreation).toEqual(SAVED_OVERRIDE);
			expect(sessionStates.get("saved")?.meta).toMatchObject({
				existing: true,
				codelia_model_override: SAVED_OVERRIDE,
			});
		} finally {
			capture.stop();
			await env.cleanup();
		}
	});

	test("model.set after binding keeps the bound-session behavior, including session switches", async () => {
		const env = await withTempEnv();
		const sessionStates = new Map([
			["bound", createSessionState("bound", { existing: true })],
			["other", savedSession("other")],
		]);
		const { capture, startRuntime } = createResumeHarness(sessionStates);
		capture.start();
		try {
			const runtime = startRuntime(env.projectDir);
			await runtime.runAndWait("bound");
			expect(runtime.state.sessionId).toBe("bound");

			const selected = await runtime.request("model.set", {
				provider: "openai",
				name: "gpt-5.4",
				scope: "session",
			});
			expect(selected.error).toBeUndefined();
			// Bound: written to the active session right away.
			expect(sessionStates.get("bound")?.meta).toMatchObject({
				existing: true,
				codelia_model_override: { provider: "openai", name: "gpt-5.4" },
			});
			expect(runtime.state.sessionModelOverridePending).toBe(false);

			// Switching to another session still loads that session's saved
			// override and leaves the other session untouched.
			await runtime.runAndWait("other");
			expect(runtime.observed.overrideAtAgentCreation).toEqual(SAVED_OVERRIDE);
			expect(sessionStates.get("other")?.meta).toMatchObject({
				codelia_model_override: SAVED_OVERRIDE,
			});
			expect(sessionStates.get("bound")?.meta).toMatchObject({
				codelia_model_override: { provider: "openai", name: "gpt-5.4" },
			});
		} finally {
			capture.stop();
			await env.cleanup();
		}
	});
});
