import { describe, expect, test } from "bun:test";
import type { Agent, Tool } from "@codelia/core";
import {
	RPC_ERROR_CODE,
	type RpcRequest,
	type RpcResponse,
} from "@codelia/protocol";
import { ApprovalRequestReceipts } from "../src/permissions/request-receipts";
import { createRuntimeHandlers } from "../src/rpc/handlers";
import { RuntimeState } from "../src/runtime-state";
import { approveFixture } from "./fixtures/approval";

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
		state.setRuntimeEnvironment({
			adapters: { approvalService: approveFixture },
		});
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
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: "unknown tool: missing_tool",
			}),
		);
	});

	test("coalesces a repeated operator call and expires its result when the owner changes", async () => {
		const state = new RuntimeState();
		state.setRuntimeEnvironment({
			adapters: { approvalService: approveFixture },
		});
		state.sessionId = "first-owner";
		let executions = 0;
		state.tools = [
			{
				name: "count",
				description: "Count fixture executions",
				definition: { name: "count", description: "Count", parameters: {} },
				executeRaw: async () => ({ type: "json", value: ++executions }),
			},
		];
		const handlers = createRuntimeHandlers({
			state,
			getAgent: async () => ({}) as Agent,
			log: () => {},
		});
		const request = (id: string, count = 1) =>
			captureResponse(() => {
				for (let attempt = 0; attempt < count; attempt++) {
					handlers.processMessage({
						jsonrpc: "2.0",
						id,
						method: "tool.call",
						params: { name: "count" },
					});
				}
			}, id);

		expect((await request("first", 2)).result).toEqual({ ok: true, result: 1 });
		expect((await request("first")).error?.message).toContain(
			"approval_receipt_expired",
		);
		state.sessionId = "second-owner";
		expect((await request("first")).error?.message).toContain(
			"approval_receipt_expired",
		);
		expect((await request("second")).result).toEqual({ ok: true, result: 2 });
		state.sessionId = "first-owner";
		expect((await request("first")).error?.message).toContain(
			"approval_receipt_expired",
		);

		const initialized = await captureResponse(() => {
			handlers.processMessage({
				jsonrpc: "2.0",
				id: "init",
				method: "initialize",
				params: {},
			});
		}, "init");
		expect(initialized.error).toBeUndefined();
		expect((await request("first")).result).toEqual({ ok: true, result: 3 });
		expect(executions).toBe(3);
	});
});

test("expired approval receipts reject replay and a fresh connection has its own capacity", async () => {
	const receipts = new ApprovalRequestReceipts<number>(1, 2);
	const state = new RuntimeState();
	state.sessionId = "owner";
	const oldConnection = state.approvalReceiptScope();
	let executions = 0;
	const start = () => ++executions;

	expect(await receipts.run(oldConnection, "first", "input", start)).toBe(1);
	expect(await receipts.run(oldConnection, "second", "input", start)).toBe(2);
	await expect(
		receipts.run(oldConnection, "first", "input", start),
	).rejects.toThrow("approval_receipt_expired");
	await expect(
		receipts.run(oldConnection, "third", "input", start),
	).rejects.toThrow("approval_receipt_capacity");
	state.setUiCapabilities({});
	await expect(
		receipts.run(oldConnection, "second", "input", start),
	).rejects.toThrow("approval_expired");
	expect(
		await receipts.run(state.approvalReceiptScope(), "third", "input", start),
	).toBe(3);
	expect(executions).toBe(3);
});

test("an in-flight result cannot be delivered after its connection ends", async () => {
	const receipts = new ApprovalRequestReceipts<string>();
	const state = new RuntimeState();
	let start!: () => void;
	let complete!: (result: string) => void;
	const started = new Promise<void>((resolve) => {
		start = resolve;
	});
	const pending = new Promise<string>((resolve) => {
		complete = resolve;
	});
	const old = receipts.run(
		state.approvalReceiptScope(),
		"request",
		"input",
		() => {
			start();
			return pending;
		},
	);
	await started;

	state.setUiCapabilities({});
	expect(
		await receipts.run(
			state.approvalReceiptScope(),
			"request",
			"input",
			() => "current",
		),
	).toBe("current");
	complete("old owner's result");

	await expect(old).rejects.toThrow("approval_expired");
});
