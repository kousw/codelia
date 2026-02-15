import type { Agent, Tool } from "@codelia/core";
import type { RpcRequest, RpcResponse } from "@codelia/protocol";
import { createRuntimeHandlers } from "../src/rpc/handlers";
import { RuntimeState } from "../src/runtime-state";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

const captureResponse = async (
	run: () => void,
	id: string,
): Promise<RpcResponse> => {
	const originalWrite = process.stdout.write.bind(process.stdout);
	let buffer = "";
	const responses: RpcResponse[] = [];
	process.stdout.write = ((chunk: string | Uint8Array) => {
		const text =
			typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		buffer += text;
		let index = buffer.indexOf("\n");
		while (index >= 0) {
			const line = buffer.slice(0, index).trim();
			buffer = buffer.slice(index + 1);
			if (line) {
				try {
					const parsed = JSON.parse(line) as unknown;
					if (isRecord(parsed) && typeof parsed.id === "string") {
						responses.push(parsed as RpcResponse);
					}
				} catch {
					// ignore
				}
			}
			index = buffer.indexOf("\n");
		}
		return true;
	}) as typeof process.stdout.write;
	try {
		run();
		const deadline = Date.now() + 1_000;
		while (Date.now() < deadline) {
			const response = responses.find((entry) => entry.id === id);
			if (response) return response;
			await Bun.sleep(10);
		}
		throw new Error("response timeout");
	} finally {
		process.stdout.write = originalWrite;
	}
};

describe("tool.call rpc", () => {
	test("invokes runtime tools directly", async () => {
		const state = new RuntimeState();
		const calls: Array<{ rawArgsJson: string }> = [];
		state.tools = [
			{
				name: "mock_tool",
				description: "mock",
				definition: {
					name: "mock_tool",
					description: "mock",
					parameters: {},
				},
				executeRaw: async (rawArgsJson) => {
					calls.push({ rawArgsJson });
					return { type: "json", value: { ok: true } };
				},
			} satisfies Tool,
		];
		const handlers = createRuntimeHandlers({
			state,
			getAgent: async () => ({}) as Agent,
			log: () => {},
		});

		const response = await captureResponse(() => {
			handlers.processMessage({
				jsonrpc: "2.0",
				id: "tool-1",
				method: "tool.call",
				params: {
					name: "mock_tool",
					arguments: { value: 42 },
				},
			} satisfies RpcRequest);
		}, "tool-1");

		expect(response.error).toBeUndefined();
		expect(response.result).toEqual({ ok: true, result: { ok: true } });
		expect(calls).toEqual([{ rawArgsJson: JSON.stringify({ value: 42 }) }]);
	});

	test("returns method error for unknown tools", async () => {
		const handlers = createRuntimeHandlers({
			state: new RuntimeState(),
			getAgent: async () => ({}) as Agent,
			log: () => {},
		});

		const response = await captureResponse(() => {
			handlers.processMessage({
				jsonrpc: "2.0",
				id: "tool-unknown",
				method: "tool.call",
				params: {
					name: "missing_tool",
					arguments: {},
				},
			} satisfies RpcRequest);
		}, "tool-unknown");

		expect(response.error).toEqual(
			expect.objectContaining({
				code: -32602,
				message: "unknown tool: missing_tool",
			}),
		);
	});
});
