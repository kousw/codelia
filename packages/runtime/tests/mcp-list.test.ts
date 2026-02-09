import { describe, expect, test } from "bun:test";
import type { Agent } from "@codelia/core";
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
			if (response) {
				return response;
			}
			await Bun.sleep(10);
		}
		throw new Error("response timeout");
	} finally {
		process.stdout.write = originalWrite;
	}
};

describe("mcp.list rpc", () => {
	test("returns mcp server states", async () => {
		const handlers = createRuntimeHandlers({
			state: new RuntimeState(),
			getAgent: async () => ({}) as Agent,
			log: () => {},
			mcpManager: {
				start: async () => undefined,
				list: () => ({
					servers: [
						{
							id: "remote-tools",
							transport: "http",
							source: "project",
							enabled: true,
							state: "ready",
							tools: 3,
						},
					],
				}),
			} as unknown as never,
		});

		const response = await captureResponse(() => {
			handlers.processMessage({
				jsonrpc: "2.0",
				id: "mcp-1",
				method: "mcp.list",
				params: { scope: "loaded" },
			} satisfies RpcRequest);
		}, "mcp-1");

		expect(response.error).toBeUndefined();
		expect(response.result).toEqual({
			servers: [
				{
					id: "remote-tools",
					transport: "http",
					source: "project",
					enabled: true,
					state: "ready",
					tools: 3,
				},
			],
		});
	});
});
