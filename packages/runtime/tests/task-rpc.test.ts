import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Agent } from "@codelia/core";
import {
	RPC_ERROR_CODE,
	type RpcRequest,
	type RpcResponse,
	type TaskInfo,
	type TaskListResult,
	type TaskResultResult,
	type TaskSpawnResult,
} from "@codelia/protocol";
import { TaskRegistryStore } from "@codelia/storage";
import { createRuntimeHandlers } from "../src/rpc/handlers";
import { RuntimeState } from "../src/runtime-state";
import { TaskManager, type TaskProcessController } from "../src/tasks";
import { MAX_EXECUTION_TIMEOUT_SECONDS } from "../src/tools/bash-utils";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

const captureResponses = async (
	run: () => void | Promise<void>,
	ids: string[],
): Promise<Map<string, RpcResponse>> => {
	const originalWrite = process.stdout.write.bind(process.stdout);
	let buffer = "";
	const responses = new Map<string, RpcResponse>();
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
						responses.set(parsed.id, parsed as RpcResponse);
					}
				} catch {
					// ignore non-RPC lines
				}
			}
			index = buffer.indexOf("\n");
		}
		return true;
	}) as typeof process.stdout.write;
	try {
		await run();
		const deadline = Date.now() + 2_000;
		while (Date.now() < deadline) {
			if (ids.every((id) => responses.has(id))) {
				return responses;
			}
			await Bun.sleep(10);
		}
		throw new Error(
			`response timeout: ${ids.filter((id) => !responses.has(id)).join(", ")}`,
		);
	} finally {
		process.stdout.write = originalWrite;
	}
};

const captureResponse = async (
	run: () => void | Promise<void>,
	id: string,
): Promise<RpcResponse> => {
	const responses = await captureResponses(run, [id]);
	const response = responses.get(id);
	if (!response) {
		throw new Error(`missing response: ${id}`);
	}
	return response;
};

const createTaskTestHandlers = async (options?: { logMessages?: string[] }) => {
	const tempRoot = await fs.mkdtemp(
		path.join(os.tmpdir(), "codelia-task-rpc-"),
	);
	const previousEnv = {
		XDG_STATE_HOME: process.env.XDG_STATE_HOME,
		XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
		XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
		XDG_DATA_HOME: process.env.XDG_DATA_HOME,
	};
	process.env.XDG_STATE_HOME = path.join(tempRoot, "state");
	process.env.XDG_CACHE_HOME = path.join(tempRoot, "cache");
	process.env.XDG_CONFIG_HOME = path.join(tempRoot, "config");
	process.env.XDG_DATA_HOME = path.join(tempRoot, "data");

	const processController: TaskProcessController = {
		isProcessAlive: async () => false,
		terminateProcess: async () => {},
		terminateProcessGroup: async () => {},
	};
	const taskManager = new TaskManager({
		registry: new TaskRegistryStore(path.join(tempRoot, "tasks")),
		processController,
	});
	const state = new RuntimeState();
	state.runtimeWorkingDir = process.cwd();
	state.runtimeSandboxRoot = process.cwd();
	const handlers = createRuntimeHandlers({
		state,
		getAgent: async () => ({}) as Agent,
		log: (message) => {
			options?.logMessages?.push(message);
		},
		taskManager,
	});
	return {
		handlers,
		async cleanup() {
			for (const [key, value] of Object.entries(previousEnv)) {
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

describe("task rpc", () => {
	test("task.spawn kind=shell -> task.result/task.wait returns retained shell output", async () => {
		const env = await createTaskTestHandlers();
		try {
			const { handlers } = env;
			const spawnResponse = await captureResponse(() => {
				handlers.processMessage({
					jsonrpc: "2.0",
					id: "task-spawn-1",
					method: "task.spawn",
					params: {
						kind: "shell",
						command:
							"node -e \"setTimeout(() => { process.stdout.write('task-shell'); }, 120)\"",
					},
				} satisfies RpcRequest);
			}, "task-spawn-1");

			expect(spawnResponse.error).toBeUndefined();
			const started = spawnResponse.result as TaskSpawnResult;
			expect(started.task_id).toBeTruthy();
			expect(started.key).toMatch(/^shell-[a-z0-9]+$/);
			expect(started.kind).toBe("shell");
			expect(started.title).toContain("node -e");

			const earlyResultResponse = await captureResponse(() => {
				handlers.processMessage({
					jsonrpc: "2.0",
					id: "task-result-early",
					method: "task.result",
					params: { task_id: started.task_id },
				} satisfies RpcRequest);
			}, "task-result-early");
			expect(earlyResultResponse.error).toBeUndefined();
			expect((earlyResultResponse.result as TaskResultResult) === null).toBe(
				true,
			);

			const waitResponse = await captureResponse(() => {
				handlers.processMessage({
					jsonrpc: "2.0",
					id: "task-wait-1",
					method: "task.wait",
					params: { task_id: started.task_id },
				} satisfies RpcRequest);
			}, "task-wait-1");

			expect(waitResponse.error).toBeUndefined();
			const waited = waitResponse.result as TaskInfo;
			expect(waited.state).toBe("completed");
			expect(waited.stdout).toBe("task-shell");
			expect(waited.exit_code).toBe(0);

			const resultResponse = await captureResponse(() => {
				handlers.processMessage({
					jsonrpc: "2.0",
					id: "task-result-final",
					method: "task.result",
					params: { task_id: started.task_id },
				} satisfies RpcRequest);
			}, "task-result-final");
			expect(resultResponse.error).toBeUndefined();
			expect((resultResponse.result as TaskInfo).stdout).toBe("task-shell");
		} finally {
			await env.cleanup();
		}
	});

	test("task.spawn uses no execution timeout for background shell tasks when timeout_seconds is omitted", async () => {
		const logs: string[] = [];
		const env = await createTaskTestHandlers({ logMessages: logs });
		try {
			const { handlers } = env;
			const spawnResponse = await captureResponse(() => {
				handlers.processMessage({
					jsonrpc: "2.0",
					id: "task-spawn-no-timeout",
					method: "task.spawn",
					params: {
						kind: "shell",
						command: `node -e "setTimeout(() => { process.stdout.write('task-done'); }, 25)"`,
					},
				} satisfies RpcRequest);
			}, "task-spawn-no-timeout");
			expect(spawnResponse.error).toBeUndefined();
			const started = spawnResponse.result as TaskSpawnResult;
			expect(logs.some((message) => message.includes("timeout_s=none"))).toBe(
				true,
			);

			const waitResponse = await captureResponse(() => {
				handlers.processMessage({
					jsonrpc: "2.0",
					id: "task-wait-no-timeout",
					method: "task.wait",
					params: { task_id: started.task_id },
				} satisfies RpcRequest);
			}, "task-wait-no-timeout");
			expect(waitResponse.error).toBeUndefined();
			expect((waitResponse.result as TaskInfo).state).toBe("completed");
		} finally {
			await env.cleanup();
		}
	});

	test("task.spawn rejects background shell timeouts beyond Node timer range", async () => {
		const env = await createTaskTestHandlers();
		try {
			const { handlers } = env;
			const response = await captureResponse(() => {
				handlers.processMessage({
					jsonrpc: "2.0",
					id: "task-spawn-timeout-overflow",
					method: "task.spawn",
					params: {
						kind: "shell",
						command: "printf overflow",
						timeout_seconds: MAX_EXECUTION_TIMEOUT_SECONDS + 1,
					},
				} satisfies RpcRequest);
			}, "task-spawn-timeout-overflow");
			expect(response.result).toBeUndefined();
			expect(response.error?.code).toBe(RPC_ERROR_CODE.INVALID_PARAMS);
			expect(response.error?.message).toContain(
				"background timeout_seconds must be",
			);
		} finally {
			await env.cleanup();
		}
	});

	test("task.spawn background=false waits for completion and returns terminal output", async () => {
		const env = await createTaskTestHandlers();
		try {
			const { handlers } = env;
			const spawnResponse = await captureResponse(() => {
				handlers.processMessage({
					jsonrpc: "2.0",
					id: "task-spawn-inline",
					method: "task.spawn",
					params: {
						kind: "shell",
						background: false,
						command: `node -e "process.stdout.write('inline-done')"`,
					},
				} satisfies RpcRequest);
			}, "task-spawn-inline");
			expect(spawnResponse.error).toBeUndefined();
			const completed = spawnResponse.result as TaskInfo;
			expect(completed.state).toBe("completed");
			expect(completed.stdout).toBe("inline-done");
			expect(completed.exit_code).toBe(0);
			expect(completed.key).toMatch(/^shell-[a-z0-9]+$/);
		} finally {
			await env.cleanup();
		}
	});

	test("task.cancel cancels a running shell task and task.list returns the retained task", async () => {
		const env = await createTaskTestHandlers();
		try {
			const { handlers } = env;
			const spawnResponse = await captureResponse(() => {
				handlers.processMessage({
					jsonrpc: "2.0",
					id: "task-spawn-cancel",
					method: "task.spawn",
					params: {
						kind: "shell",
						command:
							"node -e \"setTimeout(() => { process.stdout.write('too-late'); }, 2000)\"",
					},
				} satisfies RpcRequest);
			}, "task-spawn-cancel");
			const started = spawnResponse.result as TaskSpawnResult;

			const cancelResponse = await captureResponse(() => {
				handlers.processMessage({
					jsonrpc: "2.0",
					id: "task-cancel-1",
					method: "task.cancel",
					params: { task_id: started.task_id },
				} satisfies RpcRequest);
			}, "task-cancel-1");
			expect(cancelResponse.error).toBeUndefined();
			expect((cancelResponse.result as TaskInfo).state).toBe("cancelled");
			expect((cancelResponse.result as TaskInfo).key).toMatch(
				/^shell-[a-z0-9]+$/,
			);

			const listResponse = await captureResponse(() => {
				handlers.processMessage({
					jsonrpc: "2.0",
					id: "task-list-1",
					method: "task.list",
					params: { kind: "shell" },
				} satisfies RpcRequest);
			}, "task-list-1");
			expect(listResponse.error).toBeUndefined();
			const listed = listResponse.result as TaskListResult;
			expect(
				listed.tasks.some((task) => task.task_id === started.task_id),
			).toBe(true);
			expect(
				listed.tasks.find((task) => task.task_id === started.task_id)?.state,
			).toBe("cancelled");
			expect(
				listed.tasks.find((task) => task.task_id === started.task_id)?.key,
			).toMatch(/^shell-[a-z0-9]+$/);
		} finally {
			await env.cleanup();
		}
	});

	test("task.spawn rejects unsupported subagent kind and worktree mode", async () => {
		const env = await createTaskTestHandlers();
		try {
			const { handlers } = env;
			const subagentResponse = await captureResponse(() => {
				handlers.processMessage({
					jsonrpc: "2.0",
					id: "task-spawn-subagent",
					method: "task.spawn",
					params: {
						kind: "subagent",
						prompt: "hello",
					},
				} satisfies RpcRequest);
			}, "task-spawn-subagent");
			expect(subagentResponse.error).toEqual(
				expect.objectContaining({
					code: RPC_ERROR_CODE.INVALID_PARAMS,
					message: "task kind subagent is not supported yet.",
				}),
			);

			const worktreeResponse = await captureResponse(() => {
				handlers.processMessage({
					jsonrpc: "2.0",
					id: "task-spawn-worktree",
					method: "task.spawn",
					params: {
						kind: "shell",
						workspace_mode: "worktree",
						command: "printf 'nope'",
					},
				} satisfies RpcRequest);
			}, "task-spawn-worktree");
			expect(worktreeResponse.error).toEqual(
				expect.objectContaining({
					code: RPC_ERROR_CODE.INVALID_PARAMS,
					message: "workspace_mode=worktree is not supported yet.",
				}),
			);
		} finally {
			await env.cleanup();
		}
	});
});
