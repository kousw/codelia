import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Agent as CoreAgent } from "@codelia/core";
import type {
	Agent,
	BaseChatModel,
	ChatInvokeContext,
	ChatInvokeInput,
	RunEventStoreFactory,
	SessionRecord,
	SessionState,
	SessionStateStore,
} from "@codelia/core";
import type {
	RpcMessage,
	RpcNotification,
	RpcRequest,
	RpcResponse,
	RunStartResult,
	RunStatusNotify,
} from "@codelia/protocol";
import { createRuntimeHandlers } from "../src/rpc/handlers";
import { RuntimeState } from "../src/runtime-state";
import { createSandboxKey, SandboxContext } from "../src/sandbox/context";
import { createToolSessionContextKey } from "../src/tools/session-context";
import { createTodoReadTool } from "../src/tools/todo-read";
import { TODO_SESSION_META_KEY, todoStore } from "../src/tools/todo-store";
import { createTodoWriteTool } from "../src/tools/todo-write";

const TEST_TIMEOUT_MS = 5_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

const isRpcMessage = (value: unknown): value is RpcMessage =>
	isRecord(value) && value.jsonrpc === "2.0";

const isRpcResponse = (value: unknown): value is RpcResponse =>
	isRpcMessage(value) && "id" in value && !("method" in value);

const isRpcNotification = (value: unknown): value is RpcNotification =>
	isRpcMessage(value) && !("id" in value) && "method" in value;

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
					if (isRpcMessage(parsed)) messages.push(parsed);
				} catch {
					// ignore non-RPC stdout
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
		messages,
		async waitForResponse(id: string): Promise<RpcResponse> {
			let result: RpcResponse | undefined;
			await waitFor(() => {
				result = messages.find(
					(msg): msg is RpcResponse => isRpcResponse(msg) && msg.id === id,
				);
				return !!result;
			});
			if (!result) throw new Error(`response not found: ${id}`);
			return result;
		},
		async waitForRunStatus(runId: string, status: RunStatusNotify["status"]) {
			await waitFor(() =>
				messages.some((msg): boolean => {
					if (!isRpcNotification(msg)) return false;
					if (msg.method !== "run.status") return false;
					const params = msg.params as RunStatusNotify | undefined;
					return params?.run_id === runId && params?.status === status;
				}),
			);
		},
	};
};

class ScriptedChatModel implements BaseChatModel {
	readonly provider = "openai" as const;
	readonly model = "mock-model";
	private readonly script: ScriptedCompletion[];

	constructor(script: ScriptedCompletion[]) {
		this.script = [...script];
	}

	async ainvoke(
		_input: ChatInvokeInput & { options?: unknown },
		_context?: ChatInvokeContext,
	): Promise<ScriptedCompletion> {
		const next = this.script.shift();
		if (!next) {
			throw new Error("ScriptedChatModel: no scripted response available");
		}
		return next;
	}
}

const toolCall = (id: string, name: string, args: string): ToolCall => ({
	id,
	type: "function",
	function: { name, arguments: args },
});

const assistantResponse = (
	content: string | null,
	toolCalls: ToolCall[] = [],
): ScriptedCompletion => ({
	messages: [
		{
			role: "assistant",
			content,
			...(toolCalls.length ? { tool_calls: toolCalls } : {}),
		},
	],
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

const createRunEventStoreFactory = (
	records: SessionRecord[],
): RunEventStoreFactory => ({
	create: () => ({
		append: (record) => {
			records.push(record);
		},
	}),
});

const buildAgent = async (
	state: RuntimeState,
	script: ScriptedCompletion[],
	tempRoot: string,
): Promise<Agent> => {
	const sandbox = await SandboxContext.create(tempRoot);
	const sandboxKey = createSandboxKey(sandbox);
	const sessionContextKey = createToolSessionContextKey(() => state.sessionId);
	const tools = [
		createTodoWriteTool(sandboxKey, sessionContextKey),
		createTodoReadTool(sandboxKey, sessionContextKey),
	];
	return new CoreAgent({
		llm: new ScriptedChatModel(script),
		tools,
	}) as unknown as Agent;
};

type ScriptedCompletion = Awaited<ReturnType<BaseChatModel["ainvoke"]>>;

type ToolCall = {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
};

describe("todo session persistence", () => {
	test("todos are saved in SessionState.meta and restored on resumed runtime", async () => {
		todoStore.clear();
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "codelia-todo-persist-"));
		const stateMap = new Map<string, SessionState>();
		const records: SessionRecord[] = [];
		const capture = createStdoutCapture();
		capture.start();
		try {
			const runtimeState1 = new RuntimeState();
			const agent1 = await buildAgent(
				runtimeState1,
				[
					assistantResponse(null, [
						toolCall(
							"todo-write-1",
							"todo_write",
							'{"todos":[{"id":"persisted","content":"Persist todo","status":"pending"}]}',
						),
					]),
					assistantResponse("done"),
				],
				root,
			);
			const handlers1 = createRuntimeHandlers({
				state: runtimeState1,
				getAgent: async () => agent1,
				log: () => {},
				sessionStateStore: createSessionStateStore(stateMap),
				runEventStoreFactory: createRunEventStoreFactory(records),
			});
			handlers1.processMessage({
				jsonrpc: "2.0",
				id: "run-1",
				method: "run.start",
				params: {
					input: { type: "text", text: "start" },
				},
			} satisfies RpcRequest);

			const run1Response = await capture.waitForResponse("run-1");
			if (run1Response.error) {
				throw new Error(run1Response.error.message);
			}
			const run1Result = run1Response.result as RunStartResult | undefined;
			if (!run1Result?.run_id) {
				throw new Error("run.start did not return run_id");
			}
			await capture.waitForRunStatus(run1Result.run_id, "completed");

			const sessionId = runtimeState1.sessionId;
			if (!sessionId) throw new Error("sessionId was not set");
			const savedState = stateMap.get(sessionId);
			expect(savedState).toBeTruthy();
			const savedTodos = savedState?.meta?.[TODO_SESSION_META_KEY];
			expect(Array.isArray(savedTodos)).toBe(true);
			expect(savedTodos).toHaveLength(1);

			todoStore.clear();

			const runtimeState2 = new RuntimeState();
			const agent2 = await buildAgent(
				runtimeState2,
				[
					assistantResponse(null, [toolCall("todo-read-1", "todo_read", "{}")]),
					assistantResponse("done"),
				],
				root,
			);
			const handlers2 = createRuntimeHandlers({
				state: runtimeState2,
				getAgent: async () => agent2,
				log: () => {},
				sessionStateStore: createSessionStateStore(stateMap),
				runEventStoreFactory: createRunEventStoreFactory(records),
			});
			handlers2.processMessage({
				jsonrpc: "2.0",
				id: "run-2",
				method: "run.start",
				params: {
					input: { type: "text", text: "resume" },
					session_id: sessionId,
				},
			} satisfies RpcRequest);

			const run2Response = await capture.waitForResponse("run-2");
			if (run2Response.error) {
				throw new Error(run2Response.error.message);
			}
			const run2Result = run2Response.result as RunStartResult | undefined;
			if (!run2Result?.run_id) {
				throw new Error("run.start did not return run_id");
			}
			await capture.waitForRunStatus(run2Result.run_id, "completed");

			const todoReadEvent = capture.messages.find((msg): boolean => {
				if (!isRpcNotification(msg) || msg.method !== "agent.event") return false;
				const params = msg.params as { event?: { type?: string; tool?: string } };
				return (
					params.event?.type === "tool_result" &&
					params.event?.tool === "todo_read"
				);
			}) as RpcNotification | undefined;
			expect(todoReadEvent).toBeTruthy();
			const todoReadResult = (
				todoReadEvent?.params as {
					event?: { result?: unknown };
				}
			).event?.result;
			expect(typeof todoReadResult).toBe("string");
			expect(String(todoReadResult)).toContain("Persist todo");
		} finally {
			capture.stop();
			await fs.rm(root, { recursive: true, force: true });
			todoStore.clear();
		}
	});
});
