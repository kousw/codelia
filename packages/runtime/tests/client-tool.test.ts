import { describe, expect, test } from "bun:test";
import type { RpcMessage, RpcRequest, RpcResponse } from "@codelia/protocol";
import { createClientToolAdapters } from "../src/tools/client";
import { RuntimeState } from "../src/runtime-state";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

const isRpcMessage = (value: unknown): value is RpcMessage =>
	isRecord(value) && value.jsonrpc === "2.0";

const isRpcRequest = (value: unknown): value is RpcRequest =>
	isRpcMessage(value) && "method" in value && "id" in value;

const waitFor = async (
	condition: () => boolean,
	timeoutMs = 5_000,
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
				const parsed = JSON.parse(line) as unknown;
				if (isRpcMessage(parsed)) {
					messages.push(parsed);
				}
			}
			idx = buffer.indexOf("\n");
		}
		return true;
	};

	return {
		messages,
		start() {
			process.stdout.write = write;
		},
		stop() {
			process.stdout.write = originalWrite;
		},
		async waitForRequest(method: string): Promise<RpcRequest> {
			let result: RpcRequest | undefined;
			await waitFor(() => {
				result = messages.find(
					(msg): msg is RpcRequest =>
						isRpcRequest(msg) && msg.method === method,
				);
				return !!result;
			});
			if (!result) throw new Error(`Request not found for method=${method}`);
			return result;
		},
	};
};

describe("client tool adapters", () => {
	test("proxy execution through client.tool.call", async () => {
		const state = new RuntimeState();
		const [tool] = createClientToolAdapters({
			runId: "run-1",
			state,
			existingTools: [],
			tools: [
				{
					name: "inspect_evidence",
					description: "Inspect evidence",
					parameters: {
						type: "object",
						properties: { target: { type: "string" } },
					},
				},
			],
		});
		if (!tool) throw new Error("client tool adapter was not created");

		const capture = createStdoutCapture();
		capture.start();
		try {
			const execution = tool.executeRaw('{"target":"tab"}', {
				deps: {},
				resolve: async (key) => key.create(),
			});
			const request = await capture.waitForRequest("client.tool.call");
			expect(request.params).toEqual({
				run_id: "run-1",
				name: "inspect_evidence",
				arguments: { target: "tab" },
				raw_arguments: '{"target":"tab"}',
			});

			state.resolveUiResponse({
				jsonrpc: "2.0",
				id: request.id,
				result: { ok: true, result: { type: "text", text: "seen" } },
			} satisfies RpcResponse);

			await expect(execution).resolves.toEqual({ type: "text", text: "seen" });
		} finally {
			capture.stop();
		}
	});
});
