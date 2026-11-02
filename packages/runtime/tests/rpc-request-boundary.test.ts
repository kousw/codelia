import { describe, expect, test } from "bun:test";
import type { Agent } from "@codelia/core";
import { RPC_ERROR_CODE, type RpcResponse } from "@codelia/protocol";
import type { McpManager } from "../src/mcp/manager";
import { createRuntimeHandlers } from "../src/rpc/handlers";
import { RuntimeState } from "../src/runtime-state";

describe("RPC request boundary", () => {
	test("rejects invalid requests, contains asynchronous failures, and sends one response", async () => {
		const state = new RuntimeState();
		const responses: RpcResponse[] = [];
		const originalWrite = process.stdout.write;
		process.stdout.write = ((chunk: string | Uint8Array) => {
			for (const line of String(chunk).split("\n")) {
				if (line) responses.push(JSON.parse(line) as RpcResponse);
			}
			return true;
		}) as typeof process.stdout.write;
		try {
			const handlers = createRuntimeHandlers({
				state,
				getAgent: async () => ({}) as Agent,
				log: (message) => {
					if (message.startsWith("run.cancel")) throw new Error("log failure");
				},
				mcpManager: {
					start: async () => {
						await Promise.resolve();
						throw new Error("private implementation detail");
					},
					list: () => ({ servers: [] }),
				} as unknown as McpManager,
			});
			handlers.processMessage({
				jsonrpc: "2.0",
				id: "missing",
				method: "run.cancel",
			});
			handlers.processMessage({
				jsonrpc: "2.0",
				id: "wrong",
				method: "run.start",
				params: { session_id: 42 },
			});
			handlers.processMessage({
				jsonrpc: "2.0",
				id: "array",
				method: "run.cancel",
				params: [],
			});
			handlers.processMessage({
				jsonrpc: "1.0",
				id: "envelope",
				method: "run.cancel",
			});
			handlers.processMessage({
				jsonrpc: "2.0",
				id: "unknown",
				method: "unknown",
			});
			handlers.processMessage({
				jsonrpc: "2.0",
				id: "async",
				method: "mcp.list",
			});
			handlers.processMessage({
				jsonrpc: "2.0",
				id: "valid",
				method: "run.cancel",
				params: { run_id: "not-active" },
			});
			state.cancelRun = () => true;
			handlers.processMessage({
				jsonrpc: "2.0",
				id: "sent",
				method: "run.cancel",
				params: { run_id: "active" },
			});
			for (let attempt = 0; attempt < 100 && responses.length < 8; attempt++) {
				await Bun.sleep(5);
			}
			await Bun.sleep(10);
			const byId = (id: string) =>
				responses.filter((response) => response.id === id);
			for (const id of ["missing", "wrong", "array"]) {
				expect(byId(id)).toHaveLength(1);
				expect(byId(id)[0]?.error?.code).toBe(RPC_ERROR_CODE.INVALID_PARAMS);
			}
			expect(byId("envelope")[0]?.error?.code).toBe(
				RPC_ERROR_CODE.INVALID_REQUEST,
			);
			expect(byId("unknown")[0]?.error?.code).toBe(
				RPC_ERROR_CODE.METHOD_NOT_FOUND,
			);
			expect(byId("valid")[0]?.error?.code).toBe(RPC_ERROR_CODE.RUN_NOT_FOUND);
			expect(byId("async")).toHaveLength(1);
			expect(byId("async")[0]?.error).toEqual({
				code: RPC_ERROR_CODE.RUNTIME_INTERNAL,
				message: "internal runtime error",
			});
			expect(byId("sent")).toHaveLength(1);
			expect(byId("sent")[0]?.result).toEqual({ ok: true });
		} finally {
			process.stdout.write = originalWrite;
		}
	});

	test("a failed run-start setup releases its admitted run", async () => {
		const state = new RuntimeState();
		const responses: RpcResponse[] = [];
		const originalWrite = process.stdout.write;
		process.stdout.write = ((chunk: string | Uint8Array) => {
			for (const line of String(chunk).split("\n")) {
				if (line) responses.push(JSON.parse(line) as RpcResponse);
			}
			return true;
		}) as typeof process.stdout.write;
		try {
			const handlers = createRuntimeHandlers({
				state,
				getAgent: async () =>
					({
						getHistoryMessages: () => [],
						replaceHistoryMessages: () => {},
					}) as unknown as Agent,
				log: () => {},
				runEventStoreFactory: {
					create: () => {
						throw new Error("store unavailable");
					},
				},
			});
			handlers.processMessage({
				jsonrpc: "2.0",
				id: "start",
				method: "run.start",
				params: { input: { type: "text", text: "hello" } },
			});
			for (let attempt = 0; attempt < 100 && responses.length === 0; attempt++)
				await Bun.sleep(5);
			expect(responses).toHaveLength(1);
			expect(responses[0]?.error?.code).toBe(RPC_ERROR_CODE.RUNTIME_INTERNAL);
			expect(state.activeRunId).toBeNull();
			expect(state.activeRunSignal).toBeUndefined();
		} finally {
			process.stdout.write = originalWrite;
		}
	});
});
