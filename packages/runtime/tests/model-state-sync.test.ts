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
	};
};

const withTempEnv = async () => {
	const tempRoot = await fs.mkdtemp(
		path.join(os.tmpdir(), "codelia-model-sync-"),
	);
	const envSnapshot = new Map<string, string | undefined>();
	const setEnv = (key: string, value: string) => {
		envSnapshot.set(key, process.env[key]);
		process.env[key] = value;
	};

	setEnv("CODELIA_LAYOUT", "xdg");
	setEnv("XDG_STATE_HOME", path.join(tempRoot, "state"));
	setEnv("XDG_CACHE_HOME", path.join(tempRoot, "cache"));
	setEnv("XDG_CONFIG_HOME", path.join(tempRoot, "config-home"));
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

	const projectDir = path.join(tempRoot, "project");
	await fs.mkdir(projectDir, { recursive: true });

	return {
		projectDir,
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

describe("model state sync", () => {
	test("model.set keeps current model identity in runtime state before the next run", async () => {
		const env = await withTempEnv();
		const capture = createStdoutCapture();
		capture.start();
		try {
			const state = new RuntimeState();
			state.lastUiContext = {
				cwd: env.projectDir,
				workspace_root: env.projectDir,
			};
			state.runtimeWorkingDir = env.projectDir;
			state.currentModelProvider = "openai";
			state.currentModelName = "gpt-5";
			state.agent = {} as Agent;
			const handlers = createRuntimeHandlers({
				state,
				getAgent: async () => ({}) as Agent,
				log: () => {},
			});

			handlers.processMessage({
				jsonrpc: "2.0",
				id: "model-set-sync-1",
				method: "model.set",
				params: {
					provider: "openai",
					name: "gpt-5.3-codex",
				},
			} satisfies RpcRequest);
			const response = await capture.waitForResponse("model-set-sync-1");
			expect((response as { error?: unknown }).error).toBeUndefined();
			expect(response.result).toMatchObject({
				provider: "openai",
				name: "gpt-5.3-codex",
				source: "config",
			});
			expect(state.currentModelProvider).toBe("openai");
			expect(state.currentModelName).toBe("gpt-5.3-codex");
			expect(state.agent).toBeNull();
		} finally {
			capture.stop();
			await env.cleanup();
		}
	});

	test("model.set can switch models for the current session without writing config", async () => {
		const env = await withTempEnv();
		const capture = createStdoutCapture();
		capture.start();
		try {
			const state = new RuntimeState();
			state.lastUiContext = {
				cwd: env.projectDir,
				workspace_root: env.projectDir,
			};
			state.runtimeWorkingDir = env.projectDir;
			state.currentModelProvider = "openai";
			state.currentModelName = "gpt-5";
			const handlers = createRuntimeHandlers({
				state,
				getAgent: async () => ({}) as Agent,
				log: () => {},
			});

			handlers.processMessage({
				jsonrpc: "2.0",
				id: "model-session-set-1",
				method: "model.set",
				params: {
					provider: "openai",
					name: "gpt-5.3-codex",
					reasoning: "high",
					scope: "session",
				},
			} satisfies RpcRequest);
			const sessionResponse = await capture.waitForResponse(
				"model-session-set-1",
			);
			expect((sessionResponse as { error?: unknown }).error).toBeUndefined();
			expect(sessionResponse.result).toMatchObject({
				provider: "openai",
				name: "gpt-5.3-codex",
				reasoning: "high",
				source: "session",
			});
			expect(state.currentModelProvider).toBe("openai");
			expect(state.currentModelName).toBe("gpt-5.3-codex");
			expect(state.currentModelSource).toBe("session");

			const storedConfig = JSON.parse(
				await fs.readFile(env.configPath, "utf8"),
			) as { model?: { name?: string } };
			expect(storedConfig.model?.name).toBe("gpt-5");

			handlers.processMessage({
				jsonrpc: "2.0",
				id: "model-session-list-1",
				method: "model.list",
				params: {
					provider: "openai",
				},
			} satisfies RpcRequest);
			const listResponse = await capture.waitForResponse(
				"model-session-list-1",
			);
			expect(listResponse.result).toMatchObject({
				provider: "openai",
				current: "gpt-5.3-codex",
				reasoning: "high",
				source: "session",
			});

			handlers.processMessage({
				jsonrpc: "2.0",
				id: "model-session-reset-1",
				method: "model.set",
				params: {
					scope: "session",
					reset: true,
				},
			} satisfies RpcRequest);
			const resetResponse = await capture.waitForResponse(
				"model-session-reset-1",
			);
			expect(resetResponse.result).toMatchObject({
				provider: "openai",
				name: "gpt-5",
				source: "config",
			});
			expect(state.currentModelProvider).toBe("openai");
			expect(state.currentModelName).toBe("gpt-5");
			expect(state.currentModelSource).toBe("config");
			expect(state.sessionModelOverride).toBeNull();
		} finally {
			capture.stop();
			await env.cleanup();
		}
	});
});
