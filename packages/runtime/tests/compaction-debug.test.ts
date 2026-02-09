import { describe, expect, test } from "bun:test";
import type {
	Agent,
	AgentEvent,
	BaseMessage,
	RunEventStoreFactory,
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
					if (isRpcMessage(parsed)) {
						messages.push(parsed);
					}
				} catch {
					// ignore
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
			if (!result) throw new Error(`Response not found for id=${id}`);
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

const createStores = (): {
	runEventStoreFactory: RunEventStoreFactory;
	sessionStateStore: SessionStateStore;
} => ({
	runEventStoreFactory: {
		create: () => ({
			append: () => undefined,
		}),
	},
	sessionStateStore: {
		load: async () => null,
		save: async () => undefined,
		list: async () => [],
	},
});

const createCompactionEventAgent = (historyMessages: BaseMessage[]): Agent => {
	const runStream = async function* (): AsyncGenerator<AgentEvent> {
		yield {
			type: "compaction_complete",
			timestamp: Date.now(),
			compacted: true,
		};
		yield { type: "final", content: "done" };
	};

	return {
		runStream,
		getContextLeftPercent: () => null,
		getHistoryMessages: () => historyMessages,
		replaceHistoryMessages: (_messages: BaseMessage[]) => {},
	} as unknown as Agent;
};

const runOnce = async (
	agent: Agent,
	logs: string[],
): Promise<{ runId: string }> => {
	const capture = createStdoutCapture();
	capture.start();
	try {
		const state = new RuntimeState();
		const stores = createStores();
		const handlers = createRuntimeHandlers({
			state,
			getAgent: async () => agent,
			log: (message) => logs.push(message),
			...stores,
		});

		handlers.processMessage({
			jsonrpc: "2.0",
			id: "run-1",
			method: "run.start",
			params: {
				input: { type: "text", text: "hello" },
			},
		} satisfies RpcRequest);

		const response = await capture.waitForResponse("run-1");
		if (response.error) {
			throw new Error(`run.start failed: ${response.error.message}`);
		}
		const result = response.result as RunStartResult | undefined;
		if (!result?.run_id) {
			throw new Error("run.start did not return run_id");
		}
		await capture.waitForRunStatus(result.run_id, "completed");
		return { runId: result.run_id };
	} finally {
		capture.stop();
	}
};

describe("compaction debug logging", () => {
	test("logs compacted context snapshot when CODELIA_DEBUG=1", async () => {
		const previous = process.env.CODELIA_DEBUG;
		process.env.CODELIA_DEBUG = "1";
		try {
			const logs: string[] = [];
			const history: BaseMessage[] = [
				{
					role: "system",
					content:
						'base system\n<agents_context scope="initial">\nInstructions from: /repo/AGENTS.md\nfollow AGENTS\n</agents_context>',
				},
				{ role: "user", content: "summary after compaction" },
			];
			const { runId } = await runOnce(
				createCompactionEventAgent(history),
				logs,
			);
			const snapshotLog = logs.find((line) =>
				line.includes(`compaction context snapshot run_id=${runId}`),
			);
			expect(snapshotLog).toBeDefined();
			expect(snapshotLog ?? "").toContain("agents_context");
			expect(snapshotLog ?? "").toContain("summary after compaction");
		} finally {
			if (previous === undefined) {
				delete process.env.CODELIA_DEBUG;
			} else {
				process.env.CODELIA_DEBUG = previous;
			}
		}
	});

	test("does not log compaction snapshot when CODELIA_DEBUG is disabled", async () => {
		const previous = process.env.CODELIA_DEBUG;
		delete process.env.CODELIA_DEBUG;
		try {
			const logs: string[] = [];
			const history: BaseMessage[] = [
				{ role: "system", content: "system prompt" },
			];
			await runOnce(createCompactionEventAgent(history), logs);
			expect(
				logs.some((line) => line.includes("compaction context snapshot")),
			).toBe(false);
		} finally {
			if (previous === undefined) {
				delete process.env.CODELIA_DEBUG;
			} else {
				process.env.CODELIA_DEBUG = previous;
			}
		}
	});
});
