import { describe, expect, test } from "bun:test";
import type { Agent, BaseMessage, SessionRecord, Tool } from "@codelia/core";
import { defineTool } from "@codelia/core";
import type {
	RpcMessage,
	RpcNotification,
	RpcRequest,
	RpcResponse,
} from "@codelia/protocol";
import { z } from "zod";
import {
	resolveRuntimeEnvironment,
	type RuntimeHostAdapters,
} from "../src/environment";
import { createRuntimeHandlers } from "../src/rpc/handlers";
import { sendAgentEvent } from "../src/rpc/transport";
import { RuntimeState } from "../src/runtime-state";
import { VolatileSessionStateStore } from "../src/volatile-stores";

const TEST_TIMEOUT_MS = 2_000;

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
		await Bun.sleep(10);
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
		messages() {
			return messages.slice();
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

const hostEchoTool = (): Tool =>
	defineTool({
		name: "host_echo",
		description: "Echo a host-provided message.",
		input: z.object({ message: z.string() }),
		execute: ({ message }) => ({ echoed: message }),
	});

const createHostAdapters = (
	events: RpcNotification[] = [],
): RuntimeHostAdapters => ({
	systemPromptProvider: {
		loadSystemPrompt: () => "host system prompt",
	},
	configProvider: {
		resolveModelConfig: async () => ({
			provider: "openai",
			name: "gpt-5",
		}),
	},
	credentialProvider: {
		resolveProvider: async () => "openai",
		resolveProviderAuth: async () => ({
			method: "api_key",
			api_key: "test-api-key",
		}),
	},
	eventSink: {
		emit: (notification) => {
			events.push(notification);
		},
	},
	toolProviders: [
		{
			getTools: () => [hostEchoTool()],
		},
	],
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

describe("runtime environment contract", () => {
	test("defaults to the full TUI local runtime preset", () => {
		const environment = resolveRuntimeEnvironment();

		expect(environment.sourcePreset).toBe("tui-local");
		expect(environment.workspace.filesystem).toBe("enabled");
		expect(environment.workspace.process).toBe("runtime");
		expect(environment.workspace.root).toBe(process.cwd());
		expect(environment.context).toEqual({
			systemPrompt: "runtime-default",
			projectInstructions: "from-workspace",
			skills: "from-config",
			executionEnvironment: "from-config",
		});
		expect(environment.auth).toEqual({ model: "runtime-default" });
		expect(environment.config).toEqual({ source: "runtime-default" });
		expect(environment.tools).toEqual({
			builtin: "full-coding-agent",
			search: "from-config",
			mcp: "from-config",
			host: "disabled",
		});
		expect(environment.persistence).toEqual({ mode: "runtime" });
		expect(environment.events).toEqual({ live: "json-rpc" });
	});

	test("treats an explicit TUI-equivalent contract as TUI-local", async () => {
		const state = new RuntimeState();
		state.setRuntimeEnvironment({
			environment: {
				contract: {
					workspace: {
						filesystem: "enabled",
						process: "runtime",
					},
					context: {
						systemPrompt: "runtime-default",
						projectInstructions: "from-workspace",
						skills: "from-config",
						executionEnvironment: "from-config",
					},
					auth: { model: "runtime-default" },
					config: { source: "runtime-default" },
					tools: {
						builtin: "full-coding-agent",
						search: "from-config",
						mcp: "from-config",
						host: "disabled",
					},
					persistence: { mode: "runtime" },
					events: { live: "json-rpc" },
				},
			},
		});
		const handlers = createRuntimeHandlers({
			state,
			getAgent: async () => ({}) as Agent,
			log: () => {},
		});
		const capture = createStdoutCapture();
		capture.start();
		try {
			handlers.processMessage({
				jsonrpc: "2.0",
				id: "init-explicit-tui",
				method: "initialize",
				params: { client: { name: "test", version: "1.0.0" } },
			} satisfies RpcRequest);
			const init = await capture.waitForResponse("init-explicit-tui");
			expect(init.result).toMatchObject({
				server_capabilities: {
					supports_ui_requests: true,
					supports_theme_set: true,
					supports_shell_exec: true,
					supports_mcp_list: true,
					supports_skills_list: true,
				},
			});
		} finally {
			capture.stop();
		}
	});

	test("requires host adapters for the embedded no-local-tools preset", () => {
		expect(() =>
			resolveRuntimeEnvironment({
				environment: { preset: "embedded-no-local-tools" },
			}),
		).toThrow("adapters.systemPromptProvider");

		const environment = resolveRuntimeEnvironment({
			environment: { preset: "embedded-no-local-tools" },
			adapters: createHostAdapters(),
		});

		expect(environment.sourcePreset).toBe("embedded-no-local-tools");
		expect(environment.workspace).toEqual({
			filesystem: "disabled",
			process: "disabled",
		});
		expect(environment.tools).toEqual({
			builtin: "none",
			search: "disabled",
			mcp: "disabled",
			host: "enabled",
		});
		expect(environment.persistence).toEqual({ mode: "volatile" });
		expect(environment.events).toEqual({ live: "host" });
	});

	test("rejects unsupported partial full-coding-agent contracts", () => {
		expect(() =>
			resolveRuntimeEnvironment({
				environment: {
					contract: {
						workspace: {
							filesystem: "enabled",
							process: "runtime",
						},
						context: {
							systemPrompt: "runtime-default",
							projectInstructions: "from-workspace",
							skills: "disabled",
							executionEnvironment: "disabled",
						},
						auth: { model: "runtime-default" },
						config: { source: "runtime-default" },
						tools: {
							builtin: "full-coding-agent",
							search: "disabled",
							mcp: "disabled",
							host: "disabled",
						},
						persistence: { mode: "runtime" },
						events: { live: "json-rpc" },
					},
				},
			}),
		).toThrow("workspace project instructions and skills context");
	});

	test("rejects runtime process with volatile persistence unless a task manager is injected", () => {
		expect(() =>
			resolveRuntimeEnvironment({
				environment: {
					contract: {
						workspace: {
							filesystem: "enabled",
							process: "runtime",
						},
						context: {
							systemPrompt: "runtime-default",
							projectInstructions: "disabled",
							skills: "disabled",
							executionEnvironment: "disabled",
						},
						auth: { model: "runtime-default" },
						config: { source: "disabled" },
						tools: {
							builtin: "none",
							search: "disabled",
							mcp: "disabled",
							host: "disabled",
						},
						persistence: { mode: "volatile" },
						events: { live: "json-rpc" },
					},
				},
			}),
		).toThrow("volatile persistence requires adapters.stores.taskManager");
	});

	test("embedded runtime gates local capabilities and routes live events to host", async () => {
		const hostEvents: RpcNotification[] = [];
		let tuiConfigRead = false;
		const adapters = createHostAdapters(hostEvents);
		adapters.configProvider = {
			...adapters.configProvider,
			resolveTuiConfig: async () => {
				tuiConfigRead = true;
				return { theme: "ocean" };
			},
		};
		const state = new RuntimeState();
		state.setRuntimeEnvironment({
			environment: { preset: "embedded-no-local-tools" },
			adapters,
		});
		let mcpStarted = false;
		const handlers = createRuntimeHandlers({
			state,
			getAgent: async () => {
				state.tools = [hostEchoTool()];
				return {} as Agent;
			},
			log: () => {},
			mcpManager: {
				start: async () => {
					mcpStarted = true;
				},
				list: () => ({
					servers: [
						{
							id: "local-mcp",
							transport: "stdio",
							source: "project",
							enabled: true,
							state: "ready",
							tools: 1,
						},
					],
				}),
			} as unknown as never,
		});
		const capture = createStdoutCapture();
		capture.start();
		try {
			handlers.processMessage({
				jsonrpc: "2.0",
				id: "init-embedded",
				method: "initialize",
				params: { client: { name: "test", version: "1.0.0" } },
			} satisfies RpcRequest);
			const init = await capture.waitForResponse("init-embedded");
			expect(tuiConfigRead).toBe(false);
			expect(init.result).toMatchObject({
				server_capabilities: {
					supports_shell_exec: false,
					supports_shell_tasks: false,
					supports_tasks: false,
					supports_ui_requests: false,
					supports_mcp_list: false,
					supports_skills_list: false,
					supports_context_inspect: true,
					supports_tool_call: true,
					supports_theme_set: false,
				},
			});

			handlers.processMessage({
				jsonrpc: "2.0",
				id: "shell-disabled",
				method: "shell.exec",
				params: { command: "pwd" },
			} satisfies RpcRequest);
			const shell = await capture.waitForResponse("shell-disabled");
			expect(shell.error?.message).toBe("process execution is disabled");

			handlers.processMessage({
				jsonrpc: "2.0",
				id: "mcp-disabled",
				method: "mcp.list",
				params: { scope: "loaded" },
			} satisfies RpcRequest);
			const mcp = await capture.waitForResponse("mcp-disabled");
			expect(mcp.error).toBeUndefined();
			expect(mcp.result).toEqual({ servers: [] });
			expect(mcpStarted).toBe(false);

			handlers.processMessage({
				jsonrpc: "2.0",
				id: "context-embedded",
				method: "context.inspect",
				params: {},
			} satisfies RpcRequest);
			const context = await capture.waitForResponse("context-embedded");
			expect(context.error).toBeUndefined();
			expect(context.result).toMatchObject({
				runtime_environment: {
					source_preset: "embedded-no-local-tools",
					workspace: {
						filesystem: "disabled",
						process: "disabled",
					},
				},
			});

			handlers.processMessage({
				jsonrpc: "2.0",
				id: "tool-host",
				method: "tool.call",
				params: {
					name: "host_echo",
					arguments: { message: "hello" },
				},
			} satisfies RpcRequest);
			const tool = await capture.waitForResponse("tool-host");
			expect(tool.error).toBeUndefined();
			expect(tool.result).toEqual({
				ok: true,
				result: { echoed: "hello" },
			});

			state.beginRun("run-embedded");
			sendAgentEvent(state, "run-embedded", {
				type: "final",
				content: "done",
			});
			await waitFor(() => hostEvents.length === 1);
			expect(hostEvents).toHaveLength(1);
			expect(hostEvents[0]?.method).toBe("agent.event");

			handlers.processMessage({
				jsonrpc: "2.0",
				id: "history-embedded",
				method: "session.history",
				params: { session_id: "missing-session" },
			} satisfies RpcRequest);
			const history = await capture.waitForResponse("history-embedded");
			expect(history.error).toBeUndefined();
			expect(history.result).toEqual({
				runs: 0,
				events_sent: 0,
			});
			const replayedEvents = capture
				.messages()
				.filter(
					(message): message is RpcNotification =>
						!("id" in message) && message.method === "agent.event",
				);
			expect(replayedEvents).toHaveLength(0);
		} finally {
			capture.stop();
		}
	});

	test("serializes async host event delivery and continues after a sink failure", async () => {
		const delivered: string[] = [];
		let releaseFirst: (() => void) | undefined;
		const firstDeliveryGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let deliveryCount = 0;
		const adapters = createHostAdapters();
		adapters.eventSink = {
			emit: async (notification) => {
				deliveryCount += 1;
				const params = isRecord(notification.params) ? notification.params : {};
				const event = isRecord(params.event) ? params.event : {};
				delivered.push(String(event.content ?? ""));
				if (deliveryCount === 1) {
					await firstDeliveryGate;
					throw new Error("first sink delivery failed");
				}
			},
		};
		const state = new RuntimeState();
		state.setRuntimeEnvironment({
			environment: { preset: "embedded-no-local-tools" },
			adapters,
		});
		state.beginRun("run-ordered-events");

		sendAgentEvent(state, "run-ordered-events", {
			type: "text",
			content: "first",
			timestamp: Date.now(),
		});
		sendAgentEvent(state, "run-ordered-events", {
			type: "final",
			content: "second",
		});

		await waitFor(() => delivered.length === 1);
		expect(delivered).toEqual(["first"]);
		releaseFirst?.();
		await waitFor(() => delivered.length === 2);
		expect(delivered).toEqual(["first", "second"]);
	});

	test("lists workspace-less embedded sessions in the default scope", async () => {
		const sessionStateStore = new VolatileSessionStateStore();
		await sessionStateStore.save({
			schema_version: 1,
			session_id: "embedded-session",
			updated_at: "2026-07-10T00:00:00.000Z",
			messages: [{ role: "user", content: "hello" }],
		});
		const state = new RuntimeState();
		state.setRuntimeEnvironment({
			environment: { preset: "embedded-no-local-tools" },
			adapters: createHostAdapters(),
		});
		const handlers = createRuntimeHandlers({
			state,
			getAgent: async () => ({}) as Agent,
			log: () => {},
			sessionStateStore,
		});
		const capture = createStdoutCapture();
		capture.start();
		try {
			handlers.processMessage({
				jsonrpc: "2.0",
				id: "list-embedded-sessions",
				method: "session.list",
				params: {},
			} satisfies RpcRequest);
			const response = await capture.waitForResponse("list-embedded-sessions");
			expect(response.error).toBeUndefined();
			expect(response.result).toEqual({
				current_workspace_root: undefined,
				sessions: [
					{
						session_id: "embedded-session",
						updated_at: "2026-07-10T00:00:00.000Z",
						message_count: 1,
						last_user_message: "hello",
					},
				],
			});
		} finally {
			capture.stop();
		}
	});

	test("run session headers include the effective environment summary", async () => {
		const records: SessionRecord[] = [];
		const state = new RuntimeState();
		state.setRuntimeEnvironment({
			environment: { preset: "embedded-no-local-tools" },
			adapters: createHostAdapters(),
		});
		const handlers = createRuntimeHandlers({
			state,
			getAgent: async () => createInstantAgent(),
			log: () => {},
			runEventStoreFactory: {
				create: () => ({
					append: (record) => {
						records.push(record);
					},
				}),
			},
		});
		const capture = createStdoutCapture();
		capture.start();
		try {
			handlers.processMessage({
				jsonrpc: "2.0",
				id: "run-embedded-summary",
				method: "run.start",
				params: {
					input: { type: "text", text: "hello" },
				},
			} satisfies RpcRequest);
			await capture.waitForResponse("run-embedded-summary");
			await waitFor(() => records.some((record) => record.type === "header"));
			const header = records.find((record) => record.type === "header");
			expect(header?.meta).toMatchObject({
				runtime_environment: {
					source_preset: "embedded-no-local-tools",
					workspace: {
						filesystem: "disabled",
						process: "disabled",
					},
					persistence: { mode: "volatile" },
					events: { live: "host" },
				},
			});
		} finally {
			capture.stop();
		}
	});
});
