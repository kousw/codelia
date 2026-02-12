import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Agent } from "@codelia/core";
import type { RpcMessage, RpcRequest, RpcResponse } from "@codelia/protocol";
import { createRuntimeHandlers } from "../src/rpc/handlers";
import { RuntimeState } from "../src/runtime-state";

const TEST_TIMEOUT_MS = 5_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

const isRpcMessage = (value: unknown): value is RpcMessage =>
	isRecord(value) && value.jsonrpc === "2.0";

const isRpcResponse = (value: unknown): value is RpcResponse =>
	isRpcMessage(value) && "id" in value && !("method" in value);

const isRpcRequest = (value: unknown): value is RpcRequest =>
	isRpcMessage(value) && "id" in value && "method" in value;

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
		async waitForRequest(
			method: string,
			predicate?: (request: RpcRequest) => boolean,
		): Promise<RpcRequest> {
			let result: RpcRequest | undefined;
			await waitFor(() => {
				result = messages.find((msg): msg is RpcRequest => {
					if (!isRpcRequest(msg)) return false;
					if (msg.method !== method) return false;
					if (!predicate) return true;
					return predicate(msg);
				});
				return !!result;
			});
			if (!result) {
				throw new Error(`request not found: ${method}`);
			}
			return result;
		},
	};
};

const withTempEnv = async () => {
	const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codelia-onboard-"));
	const envSnapshot = new Map<string, string | undefined>();
	const setEnv = (key: string, value: string) => {
		envSnapshot.set(key, process.env[key]);
		process.env[key] = value;
	};

	setEnv("CODELIA_LAYOUT", "xdg");
	setEnv("XDG_STATE_HOME", path.join(tempRoot, "state"));
	setEnv("XDG_CACHE_HOME", path.join(tempRoot, "cache"));
	setEnv("XDG_CONFIG_HOME", path.join(tempRoot, "config"));
	setEnv("XDG_DATA_HOME", path.join(tempRoot, "data"));

	const configPath = path.join(tempRoot, "config.json");
	setEnv("CODELIA_CONFIG_PATH", configPath);
	await fs.mkdir(path.dirname(configPath), { recursive: true });
	await fs.writeFile(
		configPath,
		JSON.stringify(
			{
				version: 1,
				model: {
					provider: "openai",
					name: "gpt-5",
				},
			},
			null,
			2,
		),
		"utf8",
	);

	return {
		configPath,
		async cleanup() {
			for (const [key, value] of envSnapshot) {
				if (value === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = value;
				}
			}
			await fs.rm(tempRoot, { recursive: true, force: true });
		},
	};
};

describe("startup onboarding", () => {
	test("does not update model config when model selection is cancelled", async () => {
		const env = await withTempEnv();
		const logs: string[] = [];
		const capture = createStdoutCapture();
		capture.start();
		try {
			const state = new RuntimeState();
			const handlers = createRuntimeHandlers({
				state,
				getAgent: async () => ({}) as Agent,
				log: (message) => logs.push(message),
				buildProviderModelList: async () => ({
					models: ["claude-sonnet-4-5"],
				}),
			});

			handlers.processMessage({
				jsonrpc: "2.0",
				id: "init-1",
				method: "initialize",
				params: {
					client: { name: "test", version: "1.0.0" },
					ui_capabilities: {
						supports_pick: true,
						supports_prompt: true,
					},
				},
			} satisfies RpcRequest);
			await capture.waitForResponse("init-1");

			const providerPick = await capture.waitForRequest(
				"ui.pick.request",
				(request) =>
					typeof (request.params as { title?: unknown } | undefined)?.title ===
					"string" &&
					((request.params as { title?: string }).title?.includes("provider") ??
						false),
			);
			handlers.processMessage({
				jsonrpc: "2.0",
				id: providerPick.id,
				result: { ids: ["anthropic"] },
			} satisfies RpcResponse);

			const apiKeyPrompt = await capture.waitForRequest("ui.prompt.request");
			handlers.processMessage({
				jsonrpc: "2.0",
				id: apiKeyPrompt.id,
				result: { value: "test-anthropic-key" },
			} satisfies RpcResponse);

			const modelPick = await capture.waitForRequest(
				"ui.pick.request",
				(request) =>
					typeof (request.params as { title?: unknown } | undefined)?.title ===
					"string" &&
					((request.params as { title?: string }).title?.includes("Select model") ??
						false),
			);
			handlers.processMessage({
				jsonrpc: "2.0",
				id: modelPick.id,
				result: { ids: [] },
			} satisfies RpcResponse);

			await waitFor(() =>
				logs.some((message) =>
					message.includes("startup onboarding skipped (model not selected)"),
				),
			);

			const config = JSON.parse(await fs.readFile(env.configPath, "utf8")) as {
				model?: { provider?: string; name?: string };
			};
			expect(config.model).toEqual({ provider: "openai", name: "gpt-5" });
			expect(
				logs.some((message) => message.includes("startup onboarding completed")),
			).toBeFalse();
		} finally {
			capture.stop();
			await env.cleanup();
		}
	});
});
