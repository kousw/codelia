import { afterEach, describe, expect, test } from "bun:test";
import type { Agent } from "@codelia/core";
import {
	InitializeResultSchema,
	protocolErrorData,
	RPC_ERROR_CODE,
	type RpcMessage,
	type RpcRequest,
	type RpcResponse,
} from "@codelia/protocol";
import { requestClientToolCall } from "../src/rpc/client-tool-requests";
import { createRuntimeHandlers } from "../src/rpc/handlers";
import {
	notificationMessage,
	parseRequestParams,
	parseUiNotificationParams,
} from "../src/rpc/protocol";
import { requestUiConfirm } from "../src/rpc/ui-requests";
import { RuntimeState } from "../src/runtime-state";
import type { AgentTreeCoordinator } from "../src/subagents/coordinator";

const captureStdout = () => {
	const original = process.stdout.write.bind(process.stdout);
	const messages: RpcMessage[] = [];
	process.stdout.write = ((chunk: string | Uint8Array) => {
		const text =
			typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		for (const line of text.split("\n")) {
			if (line.trim()) messages.push(JSON.parse(line) as RpcMessage);
		}
		return true;
	}) as typeof process.stdout.write;
	return { messages, restore: () => (process.stdout.write = original) };
};

let restore: (() => void) | undefined;
afterEach(() => {
	restore?.();
	restore = undefined;
});

const responseFor = async (
	messages: RpcMessage[],
	id: string,
): Promise<RpcResponse> => {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		const found = messages.find(
			(message): message is RpcResponse =>
				"id" in message && message.id === id && !("method" in message),
		);
		if (found) return found;
		await Bun.sleep(5);
	}
	throw new Error(`no response for ${id}`);
};

const createHandlers = (state = new RuntimeState()) =>
	createRuntimeHandlers({
		state,
		getAgent: async () => ({}) as unknown as Agent,
		log: () => {},
	});

describe("catalog request validation", () => {
	test.each(["sandbox.get", "auto_review.configure"] as const)(
		"%s accepts omitted params and rejects explicit null",
		(method) => {
			expect(parseRequestParams(method, undefined).ok).toBe(true);
			expect(parseRequestParams(method, null)).toMatchObject({
				ok: false,
				error: { code: RPC_ERROR_CODE.INVALID_PARAMS },
			});
		},
	);

	test("strict management requests reject unknown keys at the RPC boundary", async () => {
		const capture = captureStdout();
		restore = capture.restore;
		const handlers = createHandlers();
		const requests = {
			"sandbox.get": {},
			"sandbox.set": { scope: "project", mode: "readonly" },
			"auto_review.configure": { action: "status" },
			"image.model.configure": { mode: "off" },
			"image.artifact.get": {
				artifact_id: "codelia-image-01234567-89ab-cdef-0123-456789abcdef",
			},
		};
		for (const [method, params] of Object.entries(requests)) {
			if (method === "auto_review.configure" && process.geteuid === undefined)
				continue;
			handlers.processMessage({
				jsonrpc: "2.0",
				id: method,
				method,
				params: { ...params, unexpected: true },
			});
			const reply = await responseFor(capture.messages, method);
			expect(reply.error).toMatchObject({
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				data: { issues: [{ code: "unrecognized_keys" }] },
			});
		}
	});

	test("malformed params answer INVALID_PARAMS with bounded issues and no input values", async () => {
		const capture = captureStdout();
		restore = capture.restore;
		const handlers = createHandlers();
		handlers.processMessage({
			jsonrpc: "2.0",
			id: "steer-1",
			method: "run.steer",
			params: {
				run_id: "run-secret-id",
				input: { type: "text", text: 42 },
				client_steer_id: ["secret-value"],
			},
		} satisfies RpcRequest);
		const response = await responseFor(capture.messages, "steer-1");
		expect(response.error?.code).toBe(RPC_ERROR_CODE.INVALID_PARAMS);
		expect(response.error?.message).toStartWith("invalid run.steer params: ");
		const { issues } = protocolErrorData[RPC_ERROR_CODE.INVALID_PARAMS].parse(
			response.error?.data,
		);
		expect(issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: "input.text", code: "invalid_type" }),
				expect.objectContaining({
					path: "client_steer_id",
					code: "invalid_type",
				}),
			]),
		);
		expect(issues.length).toBeLessThanOrEqual(10);
		const serialized = JSON.stringify(response.error);
		expect(serialized).not.toContain("secret");
		expect(serialized).not.toContain("42");
		expect(capture.messages).toHaveLength(1);
	});

	test("task.spawn rejects a mistyped workspace access key before child admission", async () => {
		const capture = captureStdout();
		restore = capture.restore;
		const state = new RuntimeState();
		const launched: unknown[] = [];
		state.subagentSpawn = async (params) => {
			launched.push(params);
			throw new Error("Unexpected child admission");
		};
		const handlers = createRuntimeHandlers({
			state,
			getAgent: async () => ({}) as Agent,
			log: () => {},
			subagents: { isAvailable: () => true } as AgentTreeCoordinator,
		});

		handlers.processMessage({
			jsonrpc: "2.0",
			id: "spawn-typo",
			method: "task.spawn",
			params: {
				kind: "subagent",
				name: "Scout",
				prompt: "Inspect the parser",
				workspace_acess: "read-only",
			},
		});
		const response = await responseFor(capture.messages, "spawn-typo");
		expect(response.error?.code).toBe(RPC_ERROR_CODE.INVALID_PARAMS);
		expect(launched).toHaveLength(0);
	});

	test("initialize accepts empty params and mirrors local Auto approve startup status", async () => {
		const capture = captureStdout();
		restore = capture.restore;
		const handlers = createHandlers();
		handlers.processMessage({
			jsonrpc: "2.0",
			id: "init-bad",
			method: "initialize",
			params: { client: "tui" },
		} satisfies RpcRequest);
		const bad = await responseFor(capture.messages, "init-bad");
		expect(bad.error?.code).toBe(RPC_ERROR_CODE.INVALID_PARAMS);
		handlers.processMessage({
			jsonrpc: "2.0",
			id: "init-empty",
			method: "initialize",
			params: {},
		} satisfies RpcRequest);
		const empty = await responseFor(capture.messages, "init-empty");
		expect(empty.error).toBeUndefined();
		const result = InitializeResultSchema.parse(empty.result);
		expect(result.protocol_version).toBe("0");
		expect(result.local_host).toMatchObject({
			auto_review: expect.any(String),
			auto_review_confined_launch_enabled: expect.any(Boolean),
		});
		const { theme: _theme, ...legacyStatus } = result.tui ?? {};
		expect(result.local_host).toEqual(legacyStatus);
	});
});

test("ui.context.update accepts omitted params and drops explicit null", () => {
	expect(parseUiNotificationParams("ui.context.update", undefined)).toEqual({});
	expect(parseUiNotificationParams("ui.context.update", null)).toBeNull();
});

describe("count params", () => {
	test("fractional counts still reach handlers that truncate them", () => {
		expect(parseRequestParams("shell.list", { limit: 2.5 }).ok).toBe(true);
		expect(parseRequestParams("task.list", { limit: 2.5 }).ok).toBe(true);
		expect(
			parseRequestParams("shell.output", {
				task_id: "t",
				stream: "stdout",
				line_number: 1.5,
			}).ok,
		).toBe(true);
		expect(
			parseRequestParams("session.history", {
				session_id: "s",
				max_events: 10.5,
			}).ok,
		).toBe(true);
		// Attachment offsets are validated as safe integers by the service.
		expect(
			parseRequestParams("attachment.upload.chunk", {
				upload_id: "u",
				offset: 1.5,
				data: "AA==",
			}).ok,
		).toBe(false);
	});
});

describe("runtime -> UI requests", () => {
	test("a client tool result that breaks the contract becomes a tool failure", async () => {
		const capture = captureStdout();
		restore = capture.restore;
		const state = new RuntimeState();
		const pending = requestClientToolCall(state, {
			run_id: "run-1",
			name: "tui_open_selector",
			raw_arguments: "{}",
		});
		const request = capture.messages.find(
			(message): message is RpcRequest =>
				"method" in message && "id" in message,
		);
		expect(request?.method).toBe("client.tool.call");
		state.resolveUiResponse({
			jsonrpc: "2.0",
			id: request?.id ?? "",
			result: { ok: "yes", result: "opened" },
		});
		expect(await pending).toEqual({
			ok: false,
			error: "The client returned a result that does not match the protocol.",
		});
	});
});

describe("runtime -> UI dialogs", () => {
	test("a confirm reply that breaks the contract is treated as declined", async () => {
		const capture = captureStdout();
		restore = capture.restore;
		const state = new RuntimeState();
		const replies = [{ ok: "yes" }, { ok: true, remember: null, reason: null }];
		const outcomes: unknown[] = [];
		for (const reply of replies) {
			const pending = requestUiConfirm(state, { title: "Run?", message: "ls" });
			const requests = capture.messages.filter(
				(message): message is RpcRequest =>
					"method" in message && "id" in message,
			);
			const request = requests[requests.length - 1];
			expect(request?.method).toBe("ui.confirm.request");
			state.resolveUiResponse({
				jsonrpc: "2.0",
				id: request?.id ?? "",
				result: reply,
			});
			outcomes.push(await pending);
		}
		// Older TUIs send null for unset fields; that reply is still accepted.
		expect(outcomes).toEqual([
			null,
			{ ok: true, remember: null, reason: null },
		]);
	});
});

describe("outgoing assertions", () => {
	test("CODELIA_TEST_PROTOCOL_ASSERT checks payloads without changing them", () => {
		const previous = process.env.CODELIA_TEST_PROTOCOL_ASSERT;
		try {
			process.env.CODELIA_TEST_PROTOCOL_ASSERT = "1";
			const params = { run_id: "run-1", status: "running" as const };
			expect(notificationMessage("run.status", params).params).toBe(params);
			expect(() =>
				notificationMessage("run.status", {
					run_id: "run-1",
					status: "paused" as never,
				}),
			).toThrow("protocol assertion failed for run.status params");
			delete process.env.CODELIA_TEST_PROTOCOL_ASSERT;
			expect(() =>
				notificationMessage("run.status", {
					run_id: "run-1",
					status: "paused" as never,
				}),
			).not.toThrow();
		} finally {
			if (previous === undefined)
				delete process.env.CODELIA_TEST_PROTOCOL_ASSERT;
			else process.env.CODELIA_TEST_PROTOCOL_ASSERT = previous;
		}
	});
});
