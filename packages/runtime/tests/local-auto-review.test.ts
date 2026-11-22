import { expect, spyOn, test } from "bun:test";
import { once } from "node:events";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Agent, type BaseChatModel } from "@codelia/core";
import type { AgentEventNotify, RpcResponse } from "@codelia/protocol";
import type { ToolResultEvent } from "@codelia/shared-types";
import {
	resolveStoragePaths,
	SessionStateStoreImpl,
	TaskRegistryStore,
} from "@codelia/storage";
import { createAgentFactory } from "../src/agent-factory";
import type { Confirmation } from "../src/permissions/dispatch";
import { LaunchRuleStore } from "../src/permissions/launch-rules";
import {
	confinedWorkspaceConfigName,
	runtimeLocalAutoReview,
} from "../src/permissions/local-reviewer";
import {
	authorizeRuntimeShell,
	runtimeWorkspaceGrant,
} from "../src/permissions/runtime-approval";
import type { ShellAdmission } from "../src/permissions/shell-approval";
import { MacSeatbeltBackend } from "../src/permissions/shell-backend";
import { confinedAutoLaunchDirectoryName } from "../src/permissions/workspace-config-paths";
import { createRuntimeHandlers } from "../src/rpc/handlers";
import { RuntimeState } from "../src/runtime-state";
import { TaskManager } from "../src/tasks";
import { VolatileRunEventStoreFactory } from "../src/volatile-stores";
import { fixtureShellBackend } from "./fixtures/approval";

test.skipIf(typeof process.geteuid !== "function")(
	"missing, disabled and OS-unverifiable Local Auto approve still allow manual shell approval",
	async () => {
		const root = realpathSync(
			mkdtempSync(path.join(tmpdir(), "codelia-review-off-")),
		);
		const workspace = path.join(root, "work");
		const previous = new Map<string, string | undefined>();
		const setEnv = (name: string, value: string) => {
			previous.set(name, process.env[name]);
			process.env[name] = value;
		};
		const fetcher = globalThis.fetch;
		const geteuid = Object.getOwnPropertyDescriptor(process, "geteuid");
		if (!geteuid)
			throw new Error("Expected POSIX ownership verification in fixture");
		let sends = 0;
		let prompts = 0;
		try {
			setEnv("CODELIA_LAYOUT", "xdg");
			setEnv("XDG_CONFIG_HOME", path.join(root, "config"));
			setEnv("OPENAI_API_KEY", "fixture-only");
			const directory = resolveStoragePaths().configDir;
			mkdirSync(directory, { recursive: true });
			mkdirSync(workspace);
			writeFileSync(
				path.join(workspace, "empty.test.ts"),
				'import {test} from "bun:test"; test("fixture", () => {});\n',
			);
			const config = path.join(directory, "auto-review.json");
			const state = new RuntimeState();
			state.setRuntimeEnvironment({
				adapters: {
					shellProtectionBackend: fixtureShellBackend,
					approvalService: {
						confirm: async ({ requestId, route, reviewFallback }) => {
							prompts++;
							expect(route.kind).toBe("human");
							expect(reviewFallback).toBeUndefined();
							return { requestId, choice: "allow_once" };
						},
					},
				},
			});
			state.runtimeSandboxRoot = workspace;
			state.sessionId = state.nextSessionId();
			state.beginRun("fixture", null, "Run the local test.");
			const review = runtimeLocalAutoReview(state);
			const authorize = authorizeRuntimeShell(state);
			const call = (deny = false) =>
				authorize(
					{
						cwd: workspace,
						origin: "parent_agent",
						source: "bun test",
						...(deny ? { deny: [{ tool: "shell", command: "bun test" }] } : {}),
					},
					async (admit) => {
						const child = admit();
						child.stdout.resume();
						child.stderr.resume();
						const [code] = await once(child, "close");
						expect(code).toBe(0);
						return "admitted";
					},
				);
			globalThis.fetch = Object.assign(
				async () => {
					sends++;
					throw new Error("Fixture provider unavailable");
				},
				{ preconnect: fetcher.preconnect },
			);
			for (const mode of [0o700, 0o775]) {
				chmodSync(directory, mode);
				expect(review.isEnabled(workspace)).toBe(false);
				expect(review.startupStatus(workspace).auto_review).toBe("off");
				await expect(call()).resolves.toBe("admitted");
			}

			chmodSync(directory, 0o700);
			const settings = {
				version: 3,
				enabled: true,
				mode: "pin",
				categories: ["local_shell"],
			};
			const save = (enabled: boolean) =>
				writeFileSync(config, JSON.stringify({ ...settings, enabled }), {
					mode: 0o600,
				});
			save(false);
			expect(review.isEnabled(workspace)).toBe(false);
			await expect(call()).resolves.toBe("admitted");
			save(true);
			Object.defineProperty(process, "geteuid", {
				...geteuid,
				value: undefined,
			});
			expect(review.isEnabled(workspace)).toBe(false);
			expect(review.startupStatus(workspace).auto_review).toBe("unavailable");
			await expect(call()).resolves.toBe("admitted");
			Object.defineProperty(process, "geteuid", geteuid);
			expect([sends, prompts]).toEqual([0, 4]);
			expect(review.status(workspace).confined_launch_enabled).toBe(false);
			review.configuration(workspace).enable();

			delete process.env.OPENAI_API_KEY;
			expect(review.startupStatus(workspace).auto_review_issue).toBe(
				"review_auth_unavailable",
			);
			await expect(call()).resolves.toBe("admitted");
			process.env.OPENAI_API_KEY = "fixture-only";
			const agent = {} as Agent;
			state.finishRun("fixture");
			state.recordAgentChatRoute(agent, { kind: "named" });
			state.beginRun("named", null, "Run the local test.", agent);
			writeFileSync(config, JSON.stringify({ ...settings, mode: "follow" }));
			expect(review.startupStatus(workspace).auto_review_issue).toBe(
				"review_chat_provider_unsupported",
			);
			await expect(call()).resolves.toBe("admitted");
			save(true);
			state.finishRun("named");
			state.beginRun("fixture", null, "Run the local test.");
			expect([sends, prompts]).toEqual([0, 4]);

			expect(review.startupStatus(workspace).auto_review).toBe("active");
			await expect(call(true)).rejects.toThrow("legacy_deny_rule");
			await expect(call()).resolves.toBe("admitted");
			expect([sends, prompts]).toEqual([0, 4]);

			chmodSync(directory, 0o775);
			await expect(call()).rejects.toThrow(
				"confined_launch_config_unavailable",
			);
			chmodSync(directory, 0o700);
			rmSync(config);
			expect(review.startupStatus(workspace)).toMatchObject({
				auto_review: "unavailable",
				auto_review_confined_launch_enabled: true,
			});
			await expect(call()).resolves.toBe("admitted");
			rmSync(
				path.join(
					directory,
					confinedAutoLaunchDirectoryName,
					confinedWorkspaceConfigName(workspace),
				),
			);
			expect(review.status(workspace).confined_launch_issue).toBe(
				"confined_launch_config_unavailable",
			);
			await expect(call()).rejects.toThrow(
				"confined_launch_config_unavailable",
			);
			expect([sends, prompts]).toEqual([0, 4]);

			chmodSync(directory, 0o700);
			review.configuration(workspace).disable();
			await expect(call()).resolves.toBe("admitted");
			expect([sends, prompts]).toEqual([0, 5]);
		} finally {
			Object.defineProperty(process, "geteuid", geteuid);
			globalThis.fetch = fetcher;
			for (const [name, value] of previous) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
			rmSync(root, { recursive: true, force: true });
		}
	},
);

test.skipIf(typeof process.geteuid !== "function").each(["openai", "google"])(
	"retained local TUI review path uses the selected %s reviewer for eligible requests",
	async (provider) => {
		const google = provider === "google";
		const googleId = "google/gemini-4-hydrogen";
		let cancelPicker = false;
		let changeConfigDuringSetup = false;
		let googleResponse = "valid";
		let holdReview: ((response: Response) => void) | undefined;
		let lateReply: Response | undefined;
		let reviewSignal: AbortSignal | undefined;
		let otherRouteAttempts = 0;
		const root = realpathSync(
			mkdtempSync(path.join(tmpdir(), "codelia-tui-review-")),
		);
		const workspace = path.join(root, "workspace");
		mkdirSync(workspace);
		const previous = new Map<string, string | undefined>();
		const setEnv = (key: string, value?: string) => {
			if (!previous.has(key)) previous.set(key, process.env[key]);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		};
		const stdout = process.stdout.write;
		const fetcher = globalThis.fetch;
		const state = new RuntimeState();
		const reviewPath = spyOn(
			runtimeLocalAutoReview(state),
			"confinedLaunchRevision",
		).mockReturnValue(undefined);
		const tasks = new TaskManager({
			registry: new TaskRegistryStore(path.join(root, "tasks")),
		});
		const launches: string[] = [];
		const prompts: Array<{
			title: string;
			message: string;
			items: Array<{ id: string }>;
		}> = [];
		const packets: Array<Record<string, unknown>> = [];
		const results = new Map<string, ToolResultEvent>();
		const effects: string[] = [];
		const original =
			"Inspect the workspace, add a local fixture test and run it.";
		const correction =
			"Change the expected fixture message to revised, then rerun the local test.";
		const ack = "Go ahead with that inspection.";
		const proposalText =
			"I propose listing JSON files under the workspace root.";
		const followUpCommand = "printf '%s\\n' ./*.json";
		const clarificationCommand = "printf '%s\\n' ./fixture*.txt";
		const clarifiedTarget =
			"List only generated text fixtures in the workspace root.";
		let historicalProposalId: string | undefined;
		const source =
			'import {expect, test} from "bun:test";\ntest("fixture", () => expect("first").toBe("first"));\n';
		let proposal = 0;
		let runSteer: Promise<RpcResponse> | undefined;
		let clarificationSteer: Promise<RpcResponse> | undefined;
		const toolCalls = [
			["read", { file_path: "package.json" }],
			["shell", { command: "pwd" }],
			["write", { file_path: "sample.test.ts", content: source }],
			["shell", { command: "bun run typecheck" }],
			["shell", { command: "bun test ./sample.test.ts" }],
			[
				"edit",
				{
					file_path: "sample.test.ts",
					old_string: '"first").toBe("first")',
					new_string: '"revised").toBe("revised")',
				},
			],
			["shell", { command: "bun test ./sample.test.ts" }],
			["shell", { command: "git push origin main" }],
			["shell", { command: "printf '%s\\n' *.json" }],
			["shell", { command: "printf '%s\\n' *.json", timeout: 2 }],
			["read", { file_path: "package.json" }],
			["shell", { command: "custom-inspector .env.local" }],
			["shell", { command: clarificationCommand }],
			["shell", { command: clarificationCommand }],
			["shell", { command: followUpCommand }],
		] as const;
		try {
			setEnv("CODELIA_LAYOUT", "xdg");
			setEnv("CODELIA_APPROVAL_MODE");
			setEnv("CODELIA_CONFIG_PATH", path.join(root, "config.json"));
			setEnv("CODELIA_SANDBOX_ROOT", workspace);
			setEnv("XDG_CONFIG_HOME", path.join(root, "config"));
			setEnv("XDG_CACHE_HOME", path.join(root, "cache"));
			setEnv("XDG_STATE_HOME", path.join(root, "state"));
			setEnv("OPENAI_API_KEY", "fixture-chat-key");
			writeFileSync(
				path.join(root, "config.json"),
				JSON.stringify({
					version: 1,
					model: { provider: "openai", name: "gpt-6-astra" },
					execution_environment: { startup_checks: { enabled: false } },
					skills: { enabled: false },
				}),
			);
			writeFileSync(
				path.join(workspace, "package.json"),
				JSON.stringify({
					scripts: { typecheck: "true" },
				}),
			);
			const paths = resolveStoragePaths();
			mkdirSync(paths.configDir, { recursive: true });
			const configFile = path.join(paths.configDir, "auto-review.json");
			const credential = path.join(paths.configDir, "auto-review.key");
			const settings = {
				version: 3,
				enabled: true,
				categories: ["local_shell"],
				mode: "pin",
			};
			const legacy = {
				version: 1,
				enabled: true,
				categories: ["local_test"],
				credential_file: "auto-review.key",
				max_cost_usd_micros: 600_000,
			};
			writeFileSync(credential, "fixture-legacy-key", { mode: 0o600 });
			setEnv("GOOGLE_API_KEY");
			setEnv("GEMINI_API_KEY");
			const rules = new LaunchRuleStore(path.join(root, "rules"));
			let seededAgentRule = false;
			const backend =
				process.platform === "darwin" &&
				process.env.CODELIA_APPROVAL_MAC_LIVE === "1"
					? new MacSeatbeltBackend()
					: fixtureShellBackend;
			state.setRuntimeEnvironment({
				environment: { preset: "tui-local" },
				adapters: {
					approvalLaunchRuleStore: rules,
					approvalProtectedPaths: [path.join(workspace, ".env.local")],
					approvalShellAuthority: {
						investigation: true,
						workspaceWrite: "confirm",
						stdinPipe: "forbid",
					},
					shellProtectionBackend: {
						supportsReadOnlyPaths: backend.supportsReadOnlyPaths,
						supportsHomeDotProtection: backend.supportsHomeDotProtection,
						supportsCommandBinding: backend.supportsCommandBinding,
						supports: backend.supports.bind(backend),
						supportsLaunchBinding: backend.supportsLaunchBinding?.bind(backend),
						exactLaunchBindingId: "fixture/1",
						supportsExactLaunchBinding(candidate, protection) {
							if (
								!seededAgentRule &&
								candidate.rule.origin === "parent_agent" &&
								candidate.rule.args.join(" ") === "run typecheck"
							) {
								rules.save(candidate.rule, "project", "fixture");
								seededAgentRule = true;
							}
							return (
								backend.supportsExactLaunchBinding?.(candidate, protection) ===
								true
							);
						},
						launch(invocation, protection) {
							const command =
								invocation.kind === "source"
									? invocation.source
									: [
											path.basename(invocation.executable),
											...invocation.args,
										].join(" ");
							launches.push(command);
							if (command.includes("git push"))
								throw new Error("Unexpected external launch");
							if (command === "bun test ./sample.test.ts")
								effects.push("launch-test");
							return backend.launch(invocation, protection);
						},
					},
				},
			});
			state.runtimeWorkingDir = workspace;
			state.runtimeSandboxRoot = workspace;
			globalThis.fetch = Object.assign(
				async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
					if (String(url) === "https://models.dev/api.json")
						return Response.json({
							openai: {
								models: {
									"gpt-6-astra": {
										id: "gpt-6-astra",
										name: "Fixture",
										limit: { context: 128000, output: 16384 },
									},
								},
							},
						});
					const endpoint = google
						? "https://generativelanguage.googleapis.com/v1beta/interactions"
						: "https://api.openai.com/v1/responses";
					if (String(url) !== endpoint) {
						otherRouteAttempts++;
						throw new Error("Unexpected fixture destination");
					}
					const headers = new Headers(init?.headers);
					const body = JSON.parse(String(init?.body));
					expect(init?.redirect).toBe("error");
					expect(init?.signal).toBeInstanceOf(AbortSignal);
					expect(body.store).toBe(false);
					expect(body.stream).toBe(false);
					const proposalPacket = JSON.parse(body.input);
					if (Array.isArray(proposalPacket.argv)) {
						expect(proposalPacket.argv).toEqual(["bun", "run", "typecheck"]);
						const text = JSON.stringify({
							request_id: proposalPacket.request_id,
							kind: "exact",
							argv_prefix: [],
						});
						return Response.json(
							google
								? {
										status: "completed",
										steps: [
											{
												type: "model_output",
												content: [{ type: "text", text }],
											},
										],
									}
								: {
										status: "completed",
										output: [
											{
												type: "message",
												role: "assistant",
												content: [{ type: "output_text", text }],
											},
										],
									},
						);
					}
					if (google) {
						expect(headers.get("x-goog-api-key")).toBe(
							"fixture-google-chat-key",
						);
						expect(headers.has("authorization")).toBe(false);
						expect(body.automatic_continuation).toBeUndefined();
						expect(headers.get("api-revision")).toBe("2026-05-20");
						expect(body).toMatchObject({
							model: "gemini-4-hydrogen",
							generation_config: {
								thinking_level: "low",
							},
							response_format: {
								type: "text",
								mime_type: "application/json",
								schema: {
									type: "object",
									required: ["request_id", "decision", "reason"],
									additionalProperties: false,
								},
							},
						});
						expect(body.previous_interaction_id).toBeUndefined();
						expect(body.response_format.schema.$schema).toBeUndefined();
						expect(body.tools).toBeUndefined();
					} else {
						expect(headers.get("authorization")).toBe(
							"Bearer fixture-chat-key",
						);
						expect(body).toMatchObject({ model: "gpt-6-luna", tools: [] });
					}
					expect(Buffer.byteLength(body.input)).toBeLessThanOrEqual(8192);
					expect(body.input).not.toContain(workspace);
					expect(body.input).not.toContain("fixture-chat-key");
					const packet = JSON.parse(body.input);
					const command = packet.evidence.operation.invocation.source;
					packets.push(packet);
					effects.push(
						command.startsWith("bun test") ? "review-test" : command,
					);
					if (command === "printf '%s\\n' *.json")
						return new Response(null, { status: 429 });
					const needsTarget =
						(command === clarificationCommand &&
							!JSON.stringify(packet.evidence.intent.corrections).includes(
								clarifiedTarget,
							)) ||
						(command === followUpCommand &&
							packet.evidence.intent.original.text === original);
					const text = JSON.stringify({
						request_id:
							googleResponse === "wrong-id"
								? "wrong-request"
								: packet.request_id,
						decision: command.startsWith("git push")
							? "deny"
							: googleResponse === "needs-user" ||
									googleResponse === "invalid-clarification" ||
									needsTarget
								? "ask_user"
								: googleResponse === "inconclusive" ||
										(command === followUpCommand &&
											!packet.evidence.intent.prior)
									? "insufficient_evidence"
									: "allow_once",
						reason:
							googleResponse === "invalid-clarification"
								? "Untrusted free text in clarification."
								: googleResponse === "needs-user" || needsTarget
									? "target"
									: "Fixture",
					});
					if (google) {
						const response = Response.json({
							status:
								googleResponse === "unfinished" ? "in_progress" : "completed",
							steps: [
								{ type: "thought" },
								{ type: "model_output", content: [{ type: "text", text }] },
							],
							usage: {
								total_input_tokens: 200,
								total_output_tokens: 30,
								total_thought_tokens: 10,
							},
						});
						if (googleResponse === "http-error")
							return new Response(null, { status: 429 });
						if (googleResponse === "oversize")
							return new Response("a".repeat(8 * 1024 * 1024 + 1));
						if (googleResponse === "slow" || googleResponse === "revoke") {
							lateReply = response;
							reviewSignal = init?.signal ?? undefined;
							return new Promise<Response>((resolve) => {
								holdReview = resolve;
							});
						}
						return response;
					}
					return Response.json({
						status: "completed",
						output: [
							{
								type: "message",
								role: "assistant",
								content: [{ type: "output_text", text }],
							},
						],
					});
				},
				{ preconnect: fetcher.preconnect },
			) as typeof fetch;
			const sessions = new SessionStateStoreImpl({ paths });
			const createAgent = createAgentFactory(state, {
				sessionStateStore: sessions,
				taskManager: tasks,
			});
			let fixtureAgent: Agent | undefined;
			const ainvoke: BaseChatModel["ainvoke"] = async ({ messages }) => {
				const index = proposal++;
				const call =
					index === toolCalls.length + 2 &&
					state.sessionId &&
					historicalProposalId
						? ([
								"shell",
								{
									command: followUpCommand,
									approval_context: {
										user_message_id: (
											await sessions.searchMessages(state.sessionId, {
												query: ack,
											})
										).matches[0]?.id,
										proposal_message_id: historicalProposalId,
									},
								},
							] as const)
						: index === toolCalls.length + 1
							? (["shell", { command: followUpCommand }] as const)
							: toolCalls[index];
				if (index === 5 && !JSON.stringify(messages).includes(correction))
					return {
						messages: [{ role: "assistant", content: "Missing correction" }],
					};
				return {
					messages: [
						{
							role: "assistant",
							content: call
								? ""
								: `Finished inspection where possible. Protected fixture content could not be read. ${proposalText}`,
							...(call
								? {
										tool_calls: [
											{
												id: `fixture-${index}`,
												type: "function" as const,
												function: {
													name: call[0],
													arguments: JSON.stringify(call[1]),
												},
											},
										],
									}
								: {}),
						},
					],
				};
			};
			const { processMessage } = createRuntimeHandlers({
				state,
				taskManager: tasks,
				sessionStateStore: sessions,
				runEventStoreFactory: new VolatileRunEventStoreFactory(),
				log: () => {},
				getAgent: async () => {
					if (fixtureAgent) return fixtureAgent;
					await createAgent();
					fixtureAgent = new Agent({
						llm: { provider: "openai", model: "gpt-6-astra", ainvoke },
						tools: state.tools ?? [],
						systemPrompt: "Fixture",
						compaction: null,
						toolOutputCache: null,
					});
					state.agent = fixtureAgent;
					return fixtureAgent;
				},
			});
			const wire: Array<
				RpcResponse | { method: string; params: unknown; id?: string }
			> = [];
			const call = async (method: string, params: unknown) => {
				const id = `fixture-rpc-${wire.length}-${method}`;
				processMessage({ jsonrpc: "2.0", id, method, params });
				const deadline = Date.now() + 5000;
				while (Date.now() < deadline) {
					const response = wire.find(
						(entry): entry is RpcResponse =>
							entry.id === id && !("method" in entry),
					);
					if (response) return response;
					await Bun.sleep(5);
				}
				throw new Error(`No response for ${method}`);
			};
			process.stdout.write = ((chunk: string | Uint8Array) => {
				for (const line of String(chunk).trim().split("\n")) {
					const message = JSON.parse(line);
					wire.push(message);
					if (message.method === "ui.pick.request") {
						const prompt = message.params as (typeof prompts)[number];
						let ids: string[];
						if (prompt.title === "Select an Auto approve mode") {
							ids = cancelPicker ? [] : ["pin"];
						} else if (prompt.title === "Select an Auto approve model") {
							expect(prompt.items).toEqual(
								expect.arrayContaining([
									expect.objectContaining({ id: "openai/gpt-6-luna" }),
									expect.objectContaining({
										id: googleId,
										label: expect.stringContaining(
											"Experimental / decision quality untested",
										),
									}),
									expect.objectContaining({
										id: "anthropic/claude-haiku-5-5",
										label: expect.stringContaining(
											"Experimental / decision quality untested",
										),
									}),
								]),
							);
							expect(prompt.items).toHaveLength(8);
							if (changeConfigDuringSetup) {
								writeFileSync(
									configFile,
									JSON.stringify({
										...settings,
										model: "gpt-6-luna",
										provider: "openai",
									}),
								);
							}
							ids = [googleId];
						} else {
							prompts.push(prompt);
							const choice =
								prompt.title === "Approve write?"
									? "grant_session"
									: prompt.message
												.split("\n")
												.includes("Command: bun run typecheck")
										? prompt.title === "Save this command allowance?"
											? "save_session"
											: "setup_allowance"
										: "deny_continue";
							if (prompt.title === "Approve write?")
								expect(packets).toHaveLength(0);
							const item = prompt.items.find(({ id }) =>
								id.endsWith(`/${choice}`),
							);
							ids = item ? [item.id] : [];
						}
						queueMicrotask(() =>
							processMessage({
								jsonrpc: "2.0",
								id: message.id,
								result: { ids },
							}),
						);
					}
					expect(message.method).not.toBe("ui.prompt.request");
					if (message.method === "agent.event") {
						const params = message.params as AgentEventNotify;
						if (params.event.type === "tool_result") {
							results.set(params.event.tool_call_id, params.event);
							if (params.event.tool_call_id === "fixture-4" && !runSteer)
								runSteer = call("run.steer", {
									run_id: params.run_id,
									input: { type: "text", text: correction },
								});
							if (
								params.event.tool_call_id === "fixture-12" &&
								!clarificationSteer
							)
								clarificationSteer = call("run.steer", {
									run_id: params.run_id,
									input: { type: "text", text: clarifiedTarget },
								});
						}
					}
				}
				return true;
			}) as typeof stdout;
			const initialize = () =>
				call("initialize", {
					protocol_version: "0",
					client: { name: "codelia-tui", version: "fixture" },
					ui_capabilities: {
						supports_structured_approval: true,
						supports_pick: true,
						supports_prompt: true,
						supports_run_steer: true,
					},
				});
			expect((await initialize()).result).toMatchObject({
				tui: { auto_review: "off" },
			});
			writeFileSync(
				configFile,
				JSON.stringify({ ...settings, version: 2, categories: ["local_test"] }),
				{ mode: 0o600 },
			);
			expect((await initialize()).result).toMatchObject({
				tui: {
					auto_review: "unavailable",
					auto_review_issue: "review_reconfigure_required",
				},
			});
			writeFileSync(configFile, JSON.stringify(legacy), { mode: 0o600 });
			expect((await initialize()).result).toMatchObject({
				tui: {
					auto_review: "unavailable",
					auto_review_issue: "review_reconfigure_required",
				},
			});
			expect(JSON.parse(readFileSync(configFile, "utf8"))).toEqual(legacy);
			writeFileSync(
				configFile,
				JSON.stringify({
					...settings,
					provider: "openai",
					model: "gpt-6-astra",
				}),
				{ mode: 0o600 },
			);
			expect((await initialize()).result).toMatchObject({
				tui: {
					auto_review: "unavailable",
					auto_review_issue: "unregistered_review_model",
				},
			});
			writeFileSync(configFile, JSON.stringify(settings), { mode: 0o600 });
			chmodSync(configFile, 0o644);
			expect((await initialize()).result).toMatchObject({
				tui: { auto_review: "unavailable" },
			});
			chmodSync(configFile, 0o600);
			expect((await initialize()).result).toMatchObject({
				tui: { auto_review: "active" },
			});
			if (google) {
				cancelPicker = true;
				expect((await call("auto_review.configure", {})).result).toMatchObject({
					provider: "openai",
				});
				cancelPicker = false;
				expect(JSON.parse(readFileSync(configFile, "utf8"))).toEqual(settings);
				changeConfigDuringSetup = true;
				expect((await call("auto_review.configure", {})).error).toBeDefined();
				changeConfigDuringSetup = false;
				expect(JSON.parse(readFileSync(configFile, "utf8"))).toMatchObject({
					model: "gpt-6-luna",
				});
				const picked = await call("auto_review.configure", {});
				expect(picked.error).toBeUndefined();
				expect(picked.result).toMatchObject({
					state: "unavailable",
					issue: "review_auth_unavailable",
					provider: "google",
					model: "gemini-4-hydrogen",
				});
				expect(statSync(configFile).mode & 0o777).toBe(0o600);
				expect(JSON.parse(readFileSync(configFile, "utf8"))).toEqual({
					...settings,
					provider: "google",
					model: "gemini-4-hydrogen",
				});
				expect(readFileSync(credential, "utf8")).toBe("fixture-legacy-key");
				setEnv("GEMINI_API_KEY", "fixture-google-chat-key");
				expect(
					(await call("auto_review.configure", { action: "status" })).result,
				).toMatchObject({
					state: "active",
					label: expect.stringContaining(
						"Experimental / decision quality untested",
					),
				});
				state.sessionId = state.nextSessionId();
				state.beginRun("missing-workspace-grant", null, original);
				await expect(
					authorizeRuntimeShell(state)(
						{
							cwd: workspace,
							origin: "parent_agent",
							source: "bun test ./sample.test.ts",
						},
						() => {
							throw new Error("Unexpected test admission");
						},
					),
				).rejects.toThrow("user_denied");
				expect(packets).toHaveLength(0);
				expect(prompts).toHaveLength(1);
				prompts.length = 0;
				state.finishRun("missing-workspace-grant");
			} else runtimeLocalAutoReview(state).configuration(workspace).enable();
			const started = await call("run.start", {
				input: {
					type: "text",
					text: `<shell_result>\n{"id":"fixture-bang","command_preview":"fixture","stdout":"private prior shell result"}\n</shell_result>\n\n${original}`,
				},
			});
			expect(started.error).toBeUndefined();
			const deadline = Date.now() + 10000;
			while (state.activeRunId && Date.now() < deadline) await Bun.sleep(5);
			expect(state.activeRunId).toBeNull();
			expect((await runSteer)?.error).toBeUndefined();
			expect(runSteer).toBeDefined();
			expect(proposal).toBe(toolCalls.length + 1);
			expect((await clarificationSteer)?.error).toBeUndefined();
			expect(clarificationSteer).toBeDefined();
			for (const index of [3, 4, 6]) {
				const result = results.get(`fixture-${index}`);
				expect(result?.is_error).not.toBe(true);
				expect(JSON.parse(result?.result ?? "null")).toMatchObject({
					state: "completed",
					exit_code: 0,
				});
			}
			expect(effects).toEqual([
				"review-test",
				"launch-test",
				"review-test",
				"launch-test",
				"git push origin main",
				"printf '%s\\n' *.json",
				clarificationCommand,
				clarificationCommand,
				followUpCommand,
			]);
			expect(launches).toContain("pwd");
			expect(launches.indexOf("bun run typecheck")).toBeGreaterThan(-1);
			expect(launches.indexOf("bun run typecheck")).toBeLessThan(
				launches.indexOf("bun test ./sample.test.ts"),
			);
			expect(launches).not.toContain("git push origin main");
			expect(prompts).toHaveLength(7);
			expect(prompts[0].title).toBe("Approve write?");
			expect(
				prompts.slice(1).every((prompt) => prompt.title === "Approve shell?"),
			).toBe(true);
			expect(
				prompts
					.slice(1)
					.every((prompt) => prompt.message.startsWith("Command: ")),
			).toBe(true);
			const privatePrompt = prompts.find((prompt) =>
				prompt.message.includes("review_evidence_private_path"),
			);
			expect(
				privatePrompt?.items.map(({ id }) => id.split("/").at(-1)),
			).toEqual(["allow_once", "deny_continue"]);
			expect(
				prompts.find((p) =>
					p.message.includes("Auto approve declined this command."),
				)?.message,
			).toContain("Reviewer explanation: Fixture");
			expect(
				prompts.filter((p) => p.message.includes("HTTP 429")),
			).toHaveLength(2);
			for (const index of [7, 8, 9])
				expect(results.get(`fixture-${index}`)?.result).toContain(
					"user_denied",
				);
			expect(results.get("fixture-10")?.is_error).not.toBe(true);
			expect(results.get("fixture-10")?.result).toContain("typecheck");
			expect(results.get("fixture-11")?.result).toContain("user_denied");
			expect(JSON.stringify(wire)).toContain(
				"Protected fixture content could not be read.",
			);
			expect(packets).toHaveLength(7);
			expect(results.get("fixture-12")?.result).toContain("user_denied");
			expect(results.get("fixture-13")?.is_error).not.toBe(true);
			expect(
				launches.filter((command) => command === clarificationCommand),
			).toHaveLength(1);
			expect(results.get("fixture-14")?.result).toContain("user_denied");
			expect(launches).not.toContain(followUpCommand);
			expect(packets[3]).toMatchObject({
				evidence: { operation: { coverage: "partial" } },
			});
			expect(packets[0]).toMatchObject({
				phase: "pre_launch",
				category: "local_shell",
				evidence: {
					version: 2,
					binding: expect.stringMatching(/^[a-f0-9]{64}$/u),
					operation: {
						provenance: "runtime.shell_analysis",
						operations: [["bun", "test", "./sample.test.ts"]],
						cwd: ".",
						profile: "development",
						network: "off",
						stdin: "closed",
					},
					intent: { original: { provenance: "run.start", text: original } },
				},
			});
			expect(JSON.stringify(packets[0])).not.toContain(correction);
			expect(JSON.stringify(packets)).not.toContain(
				"private prior shell result",
			);
			expect(packets[1]).toMatchObject({
				evidence: {
					intent: {
						original: { provenance: "run.start", text: original },
						corrections: [{ provenance: "run.steer", text: correction }],
					},
				},
			});
			expect(packets[0].request_id).not.toBe(packets[1].request_id);
			expect(
				readFileSync(path.join(workspace, "sample.test.ts"), "utf8"),
			).toContain('"revised"');
			if (!state.sessionId) throw new Error("Expected a session");
			historicalProposalId = (
				await sessions.searchMessages(state.sessionId, { query: proposalText })
			).matches[0]?.id;
			expect(historicalProposalId).toBeDefined();
			expect(
				(
					await call("run.start", {
						session_id: state.sessionId,
						input: { type: "text", text: ack },
					})
				).error,
			).toBeUndefined();
			const followUpDeadline = Date.now() + 5000;
			while (state.activeRunId && Date.now() < followUpDeadline)
				await Bun.sleep(5);
			expect(state.activeRunId).toBeNull();
			expect(results.get(`fixture-${toolCalls.length + 1}`)?.result).toContain(
				"user_denied",
			);
			const inconclusivePrompt = prompts.at(-1);
			expect(inconclusivePrompt?.message).toContain(
				"Auto approve could not determine",
			);
			expect(
				inconclusivePrompt?.items.map(({ id }) => id.split("/").at(-1)),
			).toEqual(["allow_once", "deny_continue"]);
			expect(
				results.get(`fixture-${toolCalls.length + 2}`)?.is_error,
				results.get(`fixture-${toolCalls.length + 2}`)?.result,
			).not.toBe(true);
			expect(
				launches.filter((command) => command === followUpCommand),
			).toHaveLength(1);
			expect(packets[8]).toMatchObject({
				evidence: {
					intent: {
						prior: {
							userMessages: [
								{ id: expect.stringMatching(/^m\d+$/u), text: ack },
							],
							proposal: {
								id: historicalProposalId,
								text: expect.stringContaining(proposalText),
							},
						},
					},
				},
			});
			expect(prompts).toHaveLength(8);
			const saved = await call("shell.start", { command: "bun run typecheck" });
			expect(saved.error).toBeUndefined();
			expect(prompts).toHaveLength(10);
			expect(
				(await call("shell.start", { command: "bun run typecheck" })).error,
			).toBeUndefined();
			expect(
				(
					await call("task.status", {
						task_id: (saved.result as { task_id: string }).task_id,
					})
				).error,
			).toBeUndefined();
			expect(
				(
					await call("tool.call", {
						name: "read",
						arguments: { file_path: "sample.test.ts" },
					})
				).error,
			).toBeUndefined();
			expect(prompts).toHaveLength(10);
			expect(packets).toHaveLength(9);
			if (google) {
				expect((await call("auto_review.configure", {})).error).toBeUndefined();
				const authorize = authorizeRuntimeShell(state);
				let activeReviewRun = "";
				const startReview = (
					id: string,
					input = "Run the local fixture tests.",
				) => {
					if (activeReviewRun) state.finishRun(activeReviewRun);
					activeReviewRun = `review-controls-${id}`;
					state.beginRun(activeReviewRun, null, input);
				};
				const ask = (
					execute: (
						admission: ShellAdmission,
					) => string | Promise<string> = () => {
						throw new Error("Unexpected test admission");
					},
				) =>
					authorize(
						{
							cwd: workspace,
							origin: "parent_agent",
							source: "bun test ./sample.test.ts",
						},
						execute,
					);
				const initialPrompts = prompts.length;
				for (const [failure, reason] of [
					["http-error", "HTTP 429"],
					["wrong-id", "review_invalid_reply"],
					["oversize", "review_response_too_large"],
					["unfinished", "review_invalid_reply"],
					["needs-user", "Auto approve asks"],
					["invalid-clarification", "review_invalid_reply"],
				]) {
					startReview(failure);
					googleResponse = failure;
					const sends = packets.length;
					await expect(ask()).rejects.toThrow("user_denied");
					expect(prompts.at(-1)?.message).toContain(reason);
					await expect(ask()).rejects.toThrow("user_denied");
					expect(packets).toHaveLength(sends + 1);
				}
				const before = prompts.length;
				expect(before).toBe(initialPrompts + 12);
				startReview(
					"url-condition",
					"Run the local test only if permission is recorded at https://review-policy.invalid/fixture.",
				);
				googleResponse = "inconclusive";
				await expect(ask()).rejects.toThrow("user_denied");
				expect(packets.at(-1)).toMatchObject({
					evidence: {
						intent: {
							original: {
								text: "Run the local test only if permission is recorded at https://review-policy.invalid/fixture.",
							},
						},
					},
				});
				expect(prompts).toHaveLength(before + 1);

				const waitForSend = async (count: number) => {
					const sentBy = Date.now() + 1000;
					while (packets.length < count && Date.now() < sentBy)
						await Bun.sleep(5);
					expect(packets).toHaveLength(count);
				};
				const finishMockReview = () => {
					if (!lateReply || !holdReview)
						throw new Error("Expected pending review");
					holdReview(lateReply);
					holdReview = undefined;
					lateReply = undefined;
				};
				googleResponse = "slow";
				startReview("slow");
				const slowCount = packets.length + 1;
				const slow = ask(() => "admitted").catch((error: unknown) => error);
				await waitForSend(slowCount);
				await Bun.sleep(5100);
				expect(reviewSignal?.aborted).toBe(false);
				finishMockReview();
				expect(await slow).toBe("admitted");
				expect(prompts).toHaveLength(before + 1);

				startReview("steer-during-review");
				const steerCount = packets.length + 1;
				const waitingReview = ask().catch((error: unknown) => error);
				await waitForSend(steerCount);
				state.enqueueRunSteer(activeReviewRun, "Do not run the test.");
				expect(String(await waitingReview)).toContain("approval_expired");
				expect(reviewSignal?.aborted).toBe(true);
				finishMockReview();

				startReview("steer-before-launch");
				googleResponse = "valid";
				const approved = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				const waitingLaunch = ask(async (admit) => {
					approved.resolve();
					await release.promise;
					admit();
					return "launched";
				}).catch((error: unknown) => error);
				await Promise.race([approved.promise, waitingLaunch]);
				state.enqueueRunSteer(activeReviewRun, "Do not run the test.");
				release.resolve();
				expect(String(await waitingLaunch)).toContain("approval_expired");
				expect(prompts).toHaveLength(before + 1);

				googleResponse = "revoke";
				startReview("review-setting-off");
				const revokeCount = packets.length + 1;
				const pending = ask().catch((error: unknown) => error);
				await waitForSend(revokeCount);
				expect(reviewSignal?.aborted).toBe(false);
				expect(
					(await call("auto_review.configure", { action: "off" })).result,
				).toMatchObject({
					confined_launch_enabled: false,
				});
				expect(reviewSignal?.aborted).toBe(true);
				expect(String(await pending)).toMatch(
					/review_unavailable|approval_expired/u,
				);
				finishMockReview();
				await expect(ask()).rejects.toThrow("user_denied");
				expect(prompts).toHaveLength(before + 2);
				expect(packets).toHaveLength(revokeCount);
				state.finishRun(activeReviewRun);
			} else {
				expect(
					(await call("auto_review.configure", { action: "off" })).result,
				).toMatchObject({ confined_launch_enabled: false });
			}
			expect(otherRouteAttempts).toBe(0);
			expect((await initialize()).result).toMatchObject({
				tui: { auto_review_confined_launch_enabled: false },
			});
		} finally {
			process.stdout.write = stdout;
			globalThis.fetch = fetcher;
			reviewPath.mockRestore();
			for (const [key, value] of previous) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			await tasks.shutdown();
			rmSync(root, { recursive: true, force: true });
		}
	},
	20_000,
);

test.skipIf(typeof process.geteuid !== "function")(
	"retained local review path withholds private intent and rechecks the active setting",
	async () => {
		const root = realpathSync(
			mkdtempSync(path.join(tmpdir(), "codelia-review-privacy-")),
		);
		const workspace = path.join(root, "work");
		const beforeLayout = process.env.CODELIA_LAYOUT;
		const beforeConfig = process.env.XDG_CONFIG_HOME;
		const beforeKey = process.env.CODELIA_FIXTURE_SECRET;
		const beforeOpenAi = process.env.OPENAI_API_KEY;
		const fetcher = globalThis.fetch;
		const state = new RuntimeState();
		const reviewPath = spyOn(
			runtimeLocalAutoReview(state),
			"confinedLaunchRevision",
		).mockReturnValue(undefined);
		const owner = state.nextSessionId();
		const prompts: Confirmation[] = [];
		let choice: "allow_once" | "deny_continue" = "deny_continue";
		let sends = 0;
		let latestPacket: unknown;
		try {
			process.env.CODELIA_LAYOUT = "xdg";
			process.env.XDG_CONFIG_HOME = path.join(root, "config");
			process.env.CODELIA_FIXTURE_SECRET = "low-entropy-demo";
			const configDir = resolveStoragePaths().configDir;
			mkdirSync(configDir, { recursive: true });
			mkdirSync(workspace);
			writeFileSync(
				path.join(workspace, "fixture.test.ts"),
				'import {test} from "bun:test"; test("fixture", () => {});\n',
			);
			const config = path.join(configDir, "auto-review.json");
			const settings = {
				version: 3,
				enabled: true,
				mode: "pin",
				categories: ["local_shell"],
			};
			writeFileSync(config, JSON.stringify(settings), { mode: 0o600 });
			runtimeLocalAutoReview(state).configuration(workspace).enable();
			process.env.OPENAI_API_KEY = "private-fixture-key";
			state.setRuntimeEnvironment({
				adapters: {
					approvalProtectedPaths: [path.join(workspace, ".env")],
					shellProtectionBackend: fixtureShellBackend,
					approvalService: {
						confirm: async (request) => {
							prompts.push(request);
							return { requestId: request.requestId, choice };
						},
					},
				},
			});
			state.runtimeSandboxRoot = workspace;
			state.sessionId = owner;
			state.setUiCapabilities({ supports_structured_approval: true });
			state.beginRun("fixture", null, "Run the local test.");
			const authorize = authorizeRuntimeShell(state);
			const grant = runtimeWorkspaceGrant(state, workspace, owner);
			grant.commit();
			globalThis.fetch = Object.assign(
				async (_url: RequestInfo | URL, init?: RequestInit) => {
					sends++;
					latestPacket = JSON.parse(JSON.parse(String(init?.body)).input);
					// A completed request without a valid verdict must not request a shell approval.
					return Response.json({ status: "completed", output: [] });
				},
				{ preconnect: fetcher.preconnect },
			) as typeof fetch;
			const ask = (
				userMessageId?: string,
				execute: (admit: ShellAdmission) => number | Promise<number> = () => {
					throw new Error("Unexpected test admission");
				},
				source = "bun test",
			) =>
				authorize(
					{
						cwd: workspace,
						origin: "parent_agent",
						source,
						...(userMessageId
							? { reviewHistory: { user_message_id: userMessageId } }
							: {}),
					},
					execute,
				);
			let run = "fixture";
			let nextRun = 0;
			const start = (text: string) => {
				state.finishRun(run);
				run = `fixture-${++nextRun}`;
				state.beginRun(run, null, text);
			};
			for (const [text, diagnostic] of [
				["Run the local test using .env.", "private_path"],
				["Run the local test with low-entropy-demo.", "credential"],
				["Run the local test using password sample.", "credential"],
				["Run the local test using private-fixture-key.", "credential"],
				[`Run the local test with AKIA${"0".repeat(16)}.`, "credential"],
				[
					"Run the tests offline. Do not send the user request.",
					"sharing_restricted",
				],
				["テストを実行。外部への送信は禁止。", "sharing_restricted"],
			] as const) {
				start(text);
				await expect(ask()).rejects.toThrow("user_denied");
				expect(prompts.at(-1)?.reviewDiagnostic?.code).toBe(
					`review_evidence_${diagnostic}`,
				);
				expect(sends, text).toBe(0);
			}
			start("Run the local test with low-entropy-demo.");
			choice = "allow_once";
			await expect(
				ask(undefined, async (admit) => {
					const child = admit();
					child.stdout.resume();
					child.stderr.resume();
					const [exitCode] = await once(child, "close");
					return exitCode;
				}),
			).resolves.toBe(0);
			const allowed = prompts.at(-1);
			expect(allowed).toMatchObject({
				reviewWithheldForPrivacy: true,
				reviewFallback: "review_evidence_unavailable",
				reviewDiagnostic: { code: "review_evidence_credential" },
				choices: ["allow_once", "deny_continue", "deny_stop"],
			});
			expect(JSON.stringify(allowed)).not.toContain("low-entropy-demo");
			choice = "deny_continue";
			await expect(ask()).rejects.toThrow("user_denied");
			expect(prompts.at(-1)?.requestId).not.toBe(allowed?.requestId);
			expect(sends).toBe(0);

			start("試".repeat(2800));
			await expect(ask()).rejects.toThrow("review_evidence_too_large");
			start("Run the local test after fixing the fixture.");
			const protectedSteer = state.enqueueRunSteer(
				run,
				"plain normalized input",
				undefined,
				"Do not send the user request.",
			);
			state.confirmApprovalSteer(run, protectedSteer);
			await expect(ask()).rejects.toThrow("user_denied");
			expect(prompts.at(-1)?.reviewDiagnostic?.code).toBe(
				"review_evidence_sharing_restricted",
			);
			const privacyPromptCount = prompts.length;
			start("Run the local test after fixing the fixture.");
			const first = state.enqueueRunSteer(
				run,
				"first",
				undefined,
				"Only run the fixture in isolation.",
			);
			await expect(ask()).rejects.toThrow("review_evidence_intent_unavailable");
			state.confirmApprovalSteer(run, first);
			await expect(ask()).rejects.toThrow("review_unavailable");
			expect(sends).toBe(1);
			const second = state.enqueueRunSteer(
				run,
				"second",
				undefined,
				"Use the revised assertion.",
			);
			state.confirmApprovalSteer(run, second);
			await expect(ask()).rejects.toThrow("review_unavailable");
			expect(sends).toBe(2);
			expect(latestPacket).toMatchObject({
				evidence: {
					intent: {
						corrections: [
							{
								provenance: "run.steer",
								text: "Only run the fixture in isolation.",
							},
							{ provenance: "run.steer", text: "Use the revised assertion." },
						],
					},
				},
			});
			expect(prompts).toHaveLength(privacyPromptCount);
			start("Run the local test after fixing the fixture.");
			await expect(ask()).rejects.toThrow("review_unavailable");
			expect(sends).toBe(3);
			writeFileSync(config, JSON.stringify({ ...settings, enabled: false }));
			await expect(ask()).rejects.toThrow("user_denied");
			expect(sends).toBe(3);
			expect(prompts).toHaveLength(privacyPromptCount + 1);
			writeFileSync(config, JSON.stringify(settings));
			await expect(ask()).rejects.toThrow("review_unavailable");
			expect(sends).toBe(4);
			state.finishRun(run);
			const historyReads: string[] = [];
			state.beginRun(
				"history",
				null,
				"Run the local test.",
				undefined,
				async (references) => {
					historyReads.push(references.user_message_id);
					if (references.user_message_id === "m1")
						throw new Error("Approval conversation window is too large");
					return {
						userMessages: [
							{
								id: "m2",
								role: "user",
								text: "Run the local test.",
								truncated: false,
							},
						],
					};
				},
			);
			await expect(ask("m1")).rejects.toThrow(
				"review_evidence_history_unavailable",
			);
			await expect(ask("m1")).rejects.toThrow(
				"review_evidence_history_unavailable",
			);
			expect(sends).toBe(4);
			await expect(ask("m2")).rejects.toThrow("review_unavailable");
			expect(historyReads).toEqual(["m1", "m2"]);
			expect(sends).toBe(5);
			state.finishRun("history");
			const sources = [
				`git diff --name-only | awk -F/ '{ print $1 }'`,
				`git diff --name-only | awk -F'/' '{ print $1 }'`,
				`git ls-files -- '/synthetic/ordinary path.txt'; git log --fixed-strings --grep='https://review-policy.invalid/fixture'`,
			];
			const publicIntent =
				"Inspect the synthetic reference https://review-policy.invalid/fixture and /synthetic/ordinary path.txt without changing local state.";
			for (const [index, source] of sources.entries()) {
				start(publicIntent);
				await expect(ask(undefined, undefined, source)).rejects.toThrow(
					"review_unavailable",
				);
				expect(sends).toBe(6 + index);
				expect(latestPacket).toMatchObject({
					evidence: {
						operation: { invocation: { source } },
						intent: { original: { text: publicIntent } },
					},
				});
			}
			expect(prompts).toHaveLength(privacyPromptCount + 1);
		} finally {
			globalThis.fetch = fetcher;
			reviewPath.mockRestore();
			for (const [key, value] of Object.entries({
				CODELIA_LAYOUT: beforeLayout,
				XDG_CONFIG_HOME: beforeConfig,
				CODELIA_FIXTURE_SECRET: beforeKey,
				OPENAI_API_KEY: beforeOpenAi,
			})) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			rmSync(root, { recursive: true, force: true });
		}
	},
);
