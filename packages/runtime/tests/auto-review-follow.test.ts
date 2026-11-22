import { expect, spyOn, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	type BaseChatModel,
	ChatAnthropic,
	ChatDeepSeek,
	ChatGoogle,
	ChatMoonshot,
	ChatOpenAI,
	ChatOpenRouter,
	ChatResponses,
	ChatXai,
	ChatZai,
} from "@codelia/core";
import type { RpcResponse, UiPickRequestParams } from "@codelia/protocol";
import { resolveStoragePaths, TaskRegistryStore } from "@codelia/storage";
import { createAgentFactory } from "../src/agent-factory";
import { configuredApiKeyAuth } from "../src/auth/resolver";
import { AuthStore } from "../src/auth/store";
import { runtimeLocalAutoReview } from "../src/permissions/local-reviewer";
import { createRuntimeHandlers } from "../src/rpc/handlers";
import { RuntimeState } from "../src/runtime-state";
import { TaskManager } from "../src/tasks";
import {
	VolatileRunEventStoreFactory,
	VolatileSessionStateStore,
} from "../src/volatile-stores";
import { fixtureShellBackend } from "./fixtures/approval";

test.skipIf(typeof process.geteuid !== "function")(
	"TUI selection enables confined launches and retains provider routing for review",
	async () => {
		const root = realpathSync(
			mkdtempSync(path.join(tmpdir(), "codelia-review-follow-")),
		);
		const workspace = path.join(root, "workspace");
		mkdirSync(workspace);
		const env = new Map<string, string | undefined>();
		const set = (name: string, value: string | undefined) => {
			if (!env.has(name)) env.set(name, process.env[name]);
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		};
		const state = new RuntimeState();
		const confinedLaunch = spyOn(
			runtimeLocalAutoReview(state),
			"confinedLaunchRevision",
		);
		const taskManager = new TaskManager({
			registry: new TaskRegistryStore(path.join(root, "tasks")),
		});
		const fetcher = globalThis.fetch;
		const stdout = process.stdout.write;
		const reviews: string[] = [];
		const chat: Array<{ provider: string; model: string }> = [];
		const approvals: Array<{
			labels: string[];
			preview: string;
			sent: number;
		}> = [];
		const toolResults: string[] = [];
		let launches = 0;
		let index = 0;
		let tools: Array<"read" | "test"> = [];
		let mode = "follow";
		let pinId = "anthropic/claude-haiku-5-5";
		let refreshRequests = 0;
		let expectedCodexToken = "fixture-codex-token";
		let hold = false;
		let pending:
			| { finish: () => void; signal?: AbortSignal | null }
			| undefined;
		const reply: BaseChatModel["ainvoke"] = async function (
			this: BaseChatModel,
		) {
			chat.push({ provider: this.provider, model: this.model });
			const tool = tools[index++];
			if (!tool)
				return { messages: [{ role: "assistant", content: "Finished." }] };
			return {
				messages: [
					{
						role: "assistant",
						content: "",
						tool_calls: [
							{
								id: `follow-test-${chat.length}`,
								type: "function",
								function: {
									name: tool === "read" ? "read" : "shell",
									arguments: JSON.stringify(
										tool === "read"
											? { file_path: "sample.test.ts" }
											: { command: "bun test" },
									),
								},
							},
						],
					},
				],
			};
		};
		// Keep real model creation, auth resolution and Agent execution. Only chat I/O is simulated.
		const mocks = [
			spyOn(ChatOpenAI.prototype, "ainvoke").mockImplementation(reply),
			spyOn(ChatGoogle.prototype, "ainvoke").mockImplementation(reply),
			spyOn(ChatAnthropic.prototype, "ainvoke").mockImplementation(reply),
			spyOn(ChatOpenRouter.prototype, "ainvoke").mockImplementation(reply),
			spyOn(ChatResponses.prototype, "ainvoke").mockImplementation(reply),
			spyOn(ChatDeepSeek.prototype, "ainvoke").mockImplementation(
				async function (this: ChatDeepSeek, input, context) {
					return {
						...(await reply.call(this, input, context)),
						provider_meta: {
							reasoning_requested: "low",
							reasoning_applied: "low",
							reasoning_effort: "low",
							reasoning_fallback: false,
						},
					};
				},
			),
			spyOn(ChatMoonshot.prototype, "ainvoke").mockImplementation(reply),
			spyOn(ChatXai.prototype, "ainvoke").mockImplementation(reply),
			spyOn(ChatZai.prototype, "ainvoke").mockImplementation(reply),
		];
		try {
			set("CODELIA_LAYOUT", "xdg");
			set("XDG_CONFIG_HOME", path.join(root, "config"));
			set("XDG_CACHE_HOME", path.join(root, "cache"));
			set("XDG_STATE_HOME", path.join(root, "state"));
			set("CODELIA_CONFIG_PATH", path.join(root, "config.json"));
			set("CODELIA_SANDBOX_ROOT", workspace);
			set("CODELIA_APPROVAL_MODE", undefined);
			set("OPENAI_BASE_URL", undefined);
			set("OPENAI_API_KEY", "fixture-openai-chat-key");
			set("GOOGLE_API_KEY", undefined);
			set("GEMINI_API_KEY", undefined);
			set("ANTHROPIC_API_KEY", "fixture-anthropic-chat-key");
			set("OPENROUTER_API_KEY", "fixture-openrouter-chat-key");
			set("DEEPSEEK_API_KEY", "fixture-deepseek-chat-key");
			set("XAI_API_KEY", "fixture-xai-chat-key");
			set("MOONSHOT_API_KEY", "fixture-moonshot-chat-key");
			set("ZAI_API_KEY", "fixture-zai-chat-key");
			set("CODELIA_FIXTURE_GATEWAY_KEY", "fixture-gateway-chat-key");
			writeFileSync(
				path.join(root, "config.json"),
				JSON.stringify({
					version: 1,
					model: { provider: "openai", name: "gpt-6-astra" },
					providers: {
						"fixture-gateway": {
							type: "responses",
							base_url: "https://fixture.invalid/v1",
							api_key_env: "CODELIA_FIXTURE_GATEWAY_KEY",
							retry: "off",
							models: {
								"gpt-6-luna": {
									context_window: 128_000,
									max_output_tokens: 16_384,
									supports_tools: true,
								},
							},
						},
					},
					execution_environment: { startup_checks: { enabled: false } },
					skills: { enabled: false },
				}),
			);
			const paths = resolveStoragePaths();
			mkdirSync(paths.configDir, { recursive: true });
			writeFileSync(
				path.join(workspace, "sample.test.ts"),
				'import { test } from "bun:test";\ntest("fixture", () => {});\n',
			);

			state.setRuntimeEnvironment({
				environment: { preset: "tui-local" },
				adapters: {
					shellProtectionBackend: {
						...fixtureShellBackend,
						launch(invocation, protection) {
							launches++;
							return fixtureShellBackend.launch(invocation, protection);
						},
					},
				},
			});
			state.runtimeWorkingDir = workspace;
			state.runtimeSandboxRoot = workspace;
			globalThis.fetch = Object.assign(
				async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
					const target = String(url);
					if (target === "https://auth.openai.com/oauth/token") {
						refreshRequests++;
						// Token rotation uses its own internal timeout signal rather than
						// the caller's abort signal, so cancelling a review cannot abort an
						// in-flight refresh.
						expect(init?.signal).toBeInstanceOf(AbortSignal);
						expect(init?.signal?.aborted).toBe(false);
						expect(init?.redirect).toBe("error");
						expect(
							new URLSearchParams(String(init?.body)).get("refresh_token"),
						).toBe("fixture-refresh-token");
						expectedCodexToken = "fixture-refreshed-codex-token";
						return Response.json({
							access_token: expectedCodexToken,
							refresh_token: "fixture-new-refresh",
							expires_in: 3600,
						});
					}
					if (target === "https://models.dev/api.json")
						return Response.json({
							openrouter: {
								models: {
									"anthropic/claude-haiku-5-5": {
										id: "anthropic/claude-haiku-5-5",
										name: "Fixture",
										tool_call: true,
										limit: { context: 128_000, output: 16_384 },
									},
								},
							},
						});
					const headers = new Headers(init?.headers);
					const body = JSON.parse(String(init?.body));
					expect(JSON.stringify(body)).not.toMatch(
						/fixture-(?:openai|anthropic|google|gateway)-chat-key|fixture\.invalid/u,
					);
					const anthropic = target === "https://api.anthropic.com/v1/messages";
					const google =
						target ===
						"https://generativelanguage.googleapis.com/v1beta/interactions";
					const codex =
						target === "https://chatgpt.com/backend-api/codex/responses";
					const request = JSON.parse(
						codex
							? body.input[0].content[0].text
							: body.messages
								? body.messages.at(-1).content
								: Array.isArray(body.input)
									? body.input.at(-1).content
									: body.input,
					);
					const text = JSON.stringify({
						request_id: request.request_id,
						decision: "allow_once",
						reason: "Fixture",
					});
					if (anthropic) {
						expect(headers.get("x-api-key")).toBe("fixture-anthropic-chat-key");
						expect(body.model).toBe("claude-haiku-5-5");
						reviews.push("anthropic");
						return Response.json({
							type: "message",
							role: "assistant",
							model: body.model,
							stop_reason: "end_turn",
							content: [{ type: "text", text }],
							usage: { input_tokens: 25, output_tokens: 15 },
						});
					}
					if (google) {
						expect(headers.get("x-goog-api-key")).toBe(
							"fixture-google-chat-key",
						);
						expect(body.model).toBe("gemini-4-hydrogen");
						reviews.push("google");
						return Response.json({
							status: "completed",
							steps: [
								{ type: "model_output", content: [{ type: "text", text }] },
							],
						});
					}
					if (codex) {
						expect(headers.get("authorization")).toBe(
							`Bearer ${expectedCodexToken}`,
						);
						expect(headers.get("chatgpt-account-id")).toBe("fixture-account");
						expect(body).toMatchObject({
							model: "gpt-6-luna",
							stream: true,
							store: false,
							tools: [],
						});
						expect(body.previous_response_id).toBeUndefined();
						reviews.push("openai-codex");
						const item = {
							type: "message",
							role: "assistant",
							content: [{ type: "output_text", text }],
						};
						return new Response(
							[
								{
									type: "response.created",
									response: { status: "in_progress" },
								},
								{ type: "response.metadata", metadata: { fixture: true } },
								{ type: "response.output_item.done", output_index: 0, item },
								{
									type: "response.completed",
									response: { status: "completed", output: [] },
								},
							]
								.map((event) => `data: ${JSON.stringify(event)}\n\n`)
								.join(""),
							{ headers: { "content-type": "text/event-stream" } },
						);
					}
					const endpoints: Record<string, string> = {
						"https://api.deepseek.com/responses": "deepseek",
						"https://api.x.ai/v1/responses": "xai",
						"https://api.moonshot.ai/v1/chat/completions": "moonshot",
						"https://api.z.ai/api/paas/v4/chat/completions": "zai",
						"https://openrouter.ai/api/v1/chat/completions": "openrouter",
					};
					const external = endpoints[target];
					if (external) {
						expect(headers.get("authorization")).toBe(
							`Bearer fixture-${external}-chat-key`,
						);
						reviews.push(external);
						const models: Record<string, string> = {
							deepseek: "deepseek-flash",
							xai: "grok-4.7",
							moonshot: "kimi-k3.1-pro",
							zai: "glm-5.3",
							openrouter: "openai/gpt-6-luna",
						};
						expect(body.model).toBe(models[external]);
						if (external === "deepseek" || external === "xai") {
							return Response.json({
								object: "response",
								model: body.model,
								status: "completed",
								store: false,
								output: [
									{
										type: "message",
										role: "assistant",
										status: "completed",
										content: [{ type: "output_text", text }],
									},
								],
							});
						}
						const completion = {
							object: "chat.completion",
							model: body.model,
							usage: { prompt_tokens: 25, completion_tokens: 15 },
							choices: [
								{
									index: 0,
									finish_reason: "stop",
									message: { role: "assistant", content: text, refusal: null },
								},
							],
						};
						if (external !== "openrouter") return Response.json(completion);
						expect(body.provider).toMatchObject({
							only: ["openai"],
							allow_fallbacks: false,
						});
						expect(headers.get("x-openrouter-metadata")).toBe("enabled");
						return Response.json({
							...completion,
							provider: "OpenAI",
							service_tier: "default",
							openrouter_metadata: {
								requested: body.model,
								strategy: "direct",
								attempt: 1,
								is_byok: false,
								endpoints: {
									total: 1,
									available: [
										{ provider: "OpenAI", model: body.model, selected: true },
									],
								},
							},
						});
					}
					expect(target).toBe("https://api.openai.com/v1/responses");
					expect(headers.get("authorization")).toBe(
						"Bearer fixture-openai-chat-key",
					);
					expect(body.model).toBe("gpt-6-luna");
					reviews.push("openai");
					const response = Response.json({
						status: "completed",
						output: [
							{
								type: "message",
								role: "assistant",
								content: [{ type: "output_text", text }],
							},
						],
					});
					if (hold)
						return new Promise<Response>((resolve) => {
							pending = {
								finish: () => resolve(response),
								signal: init?.signal,
							};
						});
					return response;
				},
				{ preconnect: fetcher.preconnect },
			) as typeof fetch;
			const sessions = new VolatileSessionStateStore();
			const { processMessage } = createRuntimeHandlers({
				state,
				taskManager,
				sessionStateStore: sessions,
				runEventStoreFactory: new VolatileRunEventStoreFactory(),
				getAgent: createAgentFactory(state, {
					taskManager,
					sessionStateStore: sessions,
				}),
				log: () => {},
			});
			const responses = new Map<string, RpcResponse>();
			let seq = 0;
			const waitFor = async (condition: () => boolean) => {
				const end = Date.now() + 5000;
				while (!condition()) {
					if (Date.now() >= end)
						throw new Error("Timed out waiting for the runtime fixture");
					await Bun.sleep(5);
				}
			};
			const call = async (method: string, params: unknown) => {
				const id = `fixture-${++seq}`;
				processMessage({ jsonrpc: "2.0", id, method, params });
				await waitFor(() => responses.has(id));
				return responses.get(id) as RpcResponse;
			};
			process.stdout.write = ((chunk: string | Uint8Array) => {
				for (const line of String(chunk).trim().split("\n")) {
					const message = JSON.parse(line);
					let result: unknown;
					if (message.method === "ui.pick.request") {
						const pick = message.params as UiPickRequestParams;
						if (pick.title === "Select an Auto approve mode") {
							expect(pick.items[0]?.id).toBe("enable");
							result = { ids: [mode] };
						} else if (pick.title === "Select an Auto approve model") {
							result = { ids: [pinId] };
						} else {
							approvals.push({
								labels: pick.items.map(({ label }) => label),
								preview: pick.message ?? "",
								sent: reviews.length,
							});
							const selection = pick.items.find(({ id }) =>
								id.endsWith("/deny_continue"),
							);
							result = { ids: selection ? [selection.id] : [] };
						}
					} else if (message.method === "ui.prompt.request") {
						throw new Error(
							"Review did not need a budget or a credential prompt",
						);
					} else if (
						message.method === "agent.event" &&
						message.params.event.type === "tool_result"
					) {
						toolResults.push(message.params.event.result);
					} else if (!message.method) responses.set(message.id, message);
					if (result)
						queueMicrotask(() =>
							processMessage({ jsonrpc: "2.0", id: message.id, result }),
						);
				}
				return true;
			}) as typeof stdout;
			expect(
				(
					await call("initialize", {
						protocol_version: "0",
						client: { name: "codelia-tui", version: "fixture" },
						ui_capabilities: {
							supports_pick: true,
							supports_prompt: true,
							supports_auth_management: true,
						},
					})
				).result,
			).toMatchObject({ tui: { auto_review: "off" } });

			const reviewConfig = () =>
				call("auto_review.configure", { action: "pick" });
			const status = async () =>
				(await call("auto_review.configure", { action: "status" })).result;
			const setModel = async (provider: string, name: string) => {
				expect(
					(await call("model.set", { scope: "session", provider, name })).error,
				).toBeUndefined();
			};
			const start = async (proposal: typeof tools, sessionId?: string) => {
				tools = proposal;
				index = 0;
				const response = await call("run.start", {
					input: { type: "text", text: "Run the local fixture tests." },
					...(sessionId ? { session_id: sessionId } : {}),
				});
				expect(response.error).toBeUndefined();
				return response.result as { run_id: string };
			};
			const run = async (proposal: typeof tools, sessionId?: string) => {
				await start(proposal, sessionId);
				await waitFor(() => !state.activeRunId);
				expect(index).toBe(proposal.length + 1);
			};

			mode = "enable";
			expect((await reviewConfig()).result).toMatchObject({
				confined_launch_enabled: true,
				state: "off",
			});
			mode = "follow";
			expect((await reviewConfig()).result).toMatchObject({
				mode: "follow",
				provider: "openai",
				state: "active",
			});
			const configFile = path.join(paths.configDir, "auto-review.json");
			expect(JSON.parse(readFileSync(configFile, "utf8"))).toEqual({
				version: 3,
				enabled: true,
				categories: ["local_shell"],
				mode: "follow",
			});
			await run(["read"]);
			expect(approvals).toHaveLength(0);
			expect(reviews).toHaveLength(0);
			expect(await status()).toMatchObject({
				mode: "follow",
				provider: "openai",
				model: "gpt-6-luna",
			});
			const beforeDirect = launches;
			await run(["test", "test"]);
			expect(launches).toBe(beforeDirect + 2);
			expect(approvals).toHaveLength(0);
			expect(reviews).toHaveLength(0);

			// Exercise the retained reviewer transport independently of confined launches.
			confinedLaunch.mockReturnValue(undefined);
			await run(["test", "test"]);
			expect(approvals).toHaveLength(0);
			expect(reviews).toEqual(["openai", "openai"]);
			state.setUiCapabilities({
				...state.uiCapabilities,
				supports_structured_approval: true,
			});
			await setModel("openai", "gpt-6.1-terra");
			await run(["test"]);
			expect(chat.at(-1)).toEqual({
				provider: "openai",
				model: "gpt-6.1-terra",
			});
			expect(reviews).toEqual(["openai", "openai", "openai"]);
			expect(approvals).toHaveLength(0);

			hold = true;
			const beforeLate = launches;
			const stalled = await start(["test"]);
			await waitFor(() => pending !== undefined);
			expect(
				(
					await call("model.set", {
						scope: "session",
						provider: "google",
						name: "gemini-4-carbon",
					})
				).error,
			).toBeDefined();
			expect((await call("run.cancel", stalled)).error).toBeUndefined();
			await waitFor(() => !state.activeRunId);
			await setModel("google", "gemini-4-carbon");
			expect(pending?.signal?.aborted).toBe(true);
			pending?.finish();
			hold = false;
			expect(launches).toBe(beforeLate);
			set("GEMINI_API_KEY", "fixture-google-chat-key");
			const beforeGoogle = reviews.length;
			await run(["test", "test"]);
			expect(approvals).toHaveLength(0);
			expect(reviews.slice(beforeGoogle)).toEqual(["google", "google"]);
			await setModel("anthropic", "claude-sonnet-5-5");
			await run(["test", "test"]);
			expect(chat.at(-1)).toEqual({
				provider: "anthropic",
				model: "claude-sonnet-5-5",
			});
			expect(reviews.slice(-2)).toEqual(["anthropic", "anthropic"]);
			expect(approvals).toHaveLength(0);

			const beforeGateway = reviews.length;
			await setModel("fixture-gateway", "gpt-6-luna");
			await run(["test"]);
			expect(chat.at(-1)?.provider).toBe("fixture-gateway");
			expect(await status()).toMatchObject({
				issue: "review_chat_provider_unsupported",
			});
			expect(reviews).toHaveLength(beforeGateway);
			expect(approvals.splice(0)).toEqual([
				expect.objectContaining({ sent: beforeGateway }),
			]);
			expect(toolResults.at(-1)).toContain("user_denied");
			await setModel("anthropic", "claude-sonnet-5-5");
			await run(["test", "test"]);
			expect(approvals).toHaveLength(0);
			expect(reviews.slice(beforeGateway)).toEqual(["anthropic", "anthropic"]);

			for (const [provider, model] of [
				["deepseek", "deepseek-v4-pro"],
				["xai", "grok-4.7"],
				["moonshot", "kimi-k3.1-pro"],
				["zai", "glm-5.3"],
				["openrouter", "anthropic/claude-haiku-5-5"],
			]) {
				await setModel(provider, model);
				const before = reviews.length;
				const executions = launches;
				await run(["read", "test", "test"]);
				expect(chat.at(-1)?.provider).toBe(provider);
				expect(approvals).toHaveLength(0);
				expect(reviews.slice(before)).toEqual([provider, provider]);
				expect(launches).toBe(executions + 2);
				expect(await status()).toMatchObject({ mode: "follow", provider });
			}

			const beforeResume = reviews.length;
			const saved = state.nextSessionId();
			await sessions.save({
				schema_version: 1,
				session_id: saved,
				updated_at: new Date().toISOString(),
				messages: [],
				meta: {
					codelia_model_override: {
						provider: "google",
						name: "gemini-4-carbon",
					},
				},
			});
			await run(["read"], saved);
			expect(chat.at(-1)).toEqual({
				provider: "google",
				model: "gemini-4-carbon",
			});
			expect(await status()).toMatchObject({
				mode: "follow",
				provider: "google",
			});
			expect(reviews).toHaveLength(beforeResume);

			mode = "pin";
			expect((await reviewConfig()).result).toMatchObject({
				mode: "pin",
				provider: "anthropic",
			});
			await run(["test", "test"]);
			expect(approvals).toHaveLength(0);
			const afterPin = approvals.length;
			await setModel("openai", "gpt-6-astra");
			await run(["test"]);
			expect(approvals).toHaveLength(afterPin);
			expect(reviews.slice(-2)).toEqual(["anthropic", "anthropic"]);
			expect(await status()).toMatchObject({
				mode: "pin",
				provider: "anthropic",
			});

			const auth = new AuthStore();
			const oauth = {
				method: "oauth" as const,
				oauth: {
					access_token: "fixture-codex-token",
					refresh_token: "fixture-refresh-token",
					expires_at: Date.now() + 120_000,
					account_id: "fixture-account",
				},
			};
			await auth.update((file) => {
				// Another provider's OAuth is incompatible even with its API key in the environment.
				file.providers.anthropic = oauth;
			});
			expect(await status()).toMatchObject({
				issue: "review_auth_incompatible",
			});
			const beforeOAuth = reviews.length;
			await run(["test"]);
			expect(reviews).toHaveLength(beforeOAuth);
			await auth.update((file) => {
				file.providers.openai = oauth;
			});
			mode = "follow";
			await reviewConfig();
			await setModel("openai", "gpt-6.1-terra");
			await run(["read", "test", "test"]);
			expect(reviews.slice(beforeOAuth)).toEqual([
				"openai-codex",
				"openai-codex",
			]);
			expect(await status()).toMatchObject({
				mode: "follow",
				provider: "openai",
				details: expect.arrayContaining([
					expect.stringContaining("existing Codex sign-in"),
				]),
			});
			await auth.update((file) => {
				file.providers.openai = {
					...oauth,
					oauth: { ...oauth.oauth, expires_at: Date.now() - 1 },
				};
			});
			await setModel("google", "gemini-4-carbon");
			mode = "pin";
			pinId = "openai/gpt-6-luna";
			await reviewConfig();
			await run(["read"]);
			expect(refreshRequests).toBe(0);
			await run(["test", "test"]);
			expect(reviews.slice(beforeOAuth)).toEqual(Array(4).fill("openai-codex"));
			expect(refreshRequests).toBe(1);
			expect(chat.at(-1)?.provider).toBe("google");

			await auth.update((file) => {
				file.providers.openai = {
					method: "api_key",
					api_key: "fixture-openai-chat-key",
				};
			});
			mode = "follow";
			await reviewConfig();
			await setModel("openai", "gpt-6-astra");
			await run(["test", "test"]);
			const beforeProxy = reviews.length;
			set("OPENAI_BASE_URL", "https://proxy.invalid/v1");
			expect(await status()).toMatchObject({
				issue: "review_auth_incompatible",
			});
			await setModel("openai", "gpt-6.1-terra");
			await run(["test"]);
			expect(reviews).toHaveLength(beforeProxy);
			set("OPENAI_BASE_URL", undefined);
			// The cached chat Agent still uses the proxy transport.
			expect(await status()).toMatchObject({
				issue: "review_auth_incompatible",
			});
			await run(["test"]);
			expect(reviews).toHaveLength(beforeProxy);
			await setModel("openai", "gpt-6-astra");
			await run(["test", "test"]);
			expect(reviews.slice(beforeProxy)).toEqual(["openai", "openai"]);
			await auth.update((file) => {
				file.providers.anthropic = {
					method: "api_key",
					api_key: "fixture-anthropic-chat-key",
				};
			});
			mode = "pin";
			for (const [baseEnv, pinned] of [
				["ZAI_BASE_URL", "zai/glm-5.3"],
				["MOONSHOT_BASE_URL", "moonshot/kimi-k3.1-pro"],
				["XAI_BASE_URL", "xai/grok-4.7"],
				["ANTHROPIC_BASE_URL", "anthropic/claude-haiku-5-5"],
				["GOOGLE_GEMINI_BASE_URL", "google/gemini-4-hydrogen"],
			]) {
				set(baseEnv, "https://different-api.invalid");
				pinId = pinned;
				expect((await reviewConfig()).result).toMatchObject({
					issue: "review_auth_incompatible",
				});
				set(baseEnv, undefined);
			}
			set("XAI_BASE_URL", "https://custom-xai.invalid/v1");
			await auth.update((file) => {
				file.providers.xai = configuredApiKeyAuth(
					"xai",
					"fixture-custom-host-key",
				);
			});
			set("XAI_BASE_URL", undefined);
			pinId = "xai/grok-4.7";
			expect((await reviewConfig()).result).toMatchObject({
				issue: "review_auth_incompatible",
			});
		} finally {
			pending?.finish();
			confinedLaunch.mockRestore();
			for (const mock of mocks) mock.mockRestore();
			process.stdout.write = stdout;
			globalThis.fetch = fetcher;
			for (const [name, value] of env) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
			await taskManager.shutdown();
			rmSync(root, { recursive: true, force: true });
		}
	},
	25_000,
);
