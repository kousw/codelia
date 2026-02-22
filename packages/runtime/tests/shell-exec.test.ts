import { describe, expect, test } from "bun:test";
import type { Agent } from "@codelia/core";
import {
	RPC_ERROR_CODE,
	type RpcRequest,
	type RpcResponse,
	type ShellExecResult,
} from "@codelia/protocol";
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
		const deadline = Date.now() + 2_000;
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

describe("shell.exec rpc", () => {
	test("executes shell command and returns output", async () => {
		const state = new RuntimeState();
		state.runtimeWorkingDir = process.cwd();
		state.runtimeSandboxRoot = process.cwd();
		const handlers = createRuntimeHandlers({
			state,
			getAgent: async () => ({}) as Agent,
			log: () => {},
		});

		const response = await captureResponse(() => {
			handlers.processMessage({
				jsonrpc: "2.0",
				id: "shell-1",
				method: "shell.exec",
				params: {
					command: "printf 'hello-shell'",
				},
			} satisfies RpcRequest);
		}, "shell-1");

		expect(response.error).toBeUndefined();
		const result = response.result as ShellExecResult;
		expect(result.command_preview).toContain("printf");
		expect(result.stdout).toBe("hello-shell");
		expect(result.exit_code).toBe(0);
	});

	test("truncates oversized single-line stdout and returns cache id", async () => {
		const state = new RuntimeState();
		state.runtimeWorkingDir = process.cwd();
		state.runtimeSandboxRoot = process.cwd();
		const handlers = createRuntimeHandlers({
			state,
			getAgent: async () => ({}) as Agent,
			log: () => {},
		});

		const response = await captureResponse(() => {
			handlers.processMessage({
				jsonrpc: "2.0",
				id: "shell-oversized-line",
				method: "shell.exec",
				params: {
					command: "node -e \"process.stdout.write('x'.repeat(70000))\"",
				},
			} satisfies RpcRequest);
		}, "shell-oversized-line");

		expect(response.error).toBeUndefined();
		const result = response.result as ShellExecResult;
		expect(result.truncated.stdout).toBe(true);
		expect(result.truncated.combined).toBe(true);
		expect(result.stdout.length).toBeLessThan(70000);
		expect(result.stdout).toContain("...[truncated by size]...");
		expect(result.stdout_cache_id).toBeDefined();
	});

	test("rejects cwd outside sandbox root", async () => {
		const state = new RuntimeState();
		state.runtimeWorkingDir = process.cwd();
		state.runtimeSandboxRoot = process.cwd();
		const handlers = createRuntimeHandlers({
			state,
			getAgent: async () => ({}) as Agent,
			log: () => {},
		});

		const response = await captureResponse(() => {
			handlers.processMessage({
				jsonrpc: "2.0",
				id: "shell-2",
				method: "shell.exec",
				params: {
					command: "pwd",
					cwd: "../../",
				},
			} satisfies RpcRequest);
		}, "shell-2");

		expect(response.error).toEqual(
			expect.objectContaining({
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: "cwd is outside sandbox root",
			}),
		);
	});
});
