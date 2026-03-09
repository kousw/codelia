import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Agent } from "@codelia/core";
import {
	RPC_ERROR_CODE,
	type InitializeResult,
	type RpcRequest,
	type RpcResponse,
	type ShellDetachResult,
	type ShellExecResult,
	type ShellListResult,
	type ShellOutputResult,
	type ShellStartResult,
} from "@codelia/protocol";
import { TaskRegistryStore } from "@codelia/storage";
import { createRuntimeHandlers } from "../src/rpc/handlers";
import { RuntimeState } from "../src/runtime-state";
import { TaskManager } from "../src/tasks";
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
					// ignore
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

const createShellTestHandlers = (
	taskManager?: TaskManager,
	logMessages?: string[],
) => {
	const state = new RuntimeState();
	state.runtimeWorkingDir = process.cwd();
	state.runtimeSandboxRoot = process.cwd();
	return createRuntimeHandlers({
		state,
		getAgent: async () => ({}) as Agent,
		log: (message) => {
			logMessages?.push(message);
		},
		...(taskManager ? { taskManager } : {}),
	});
};

const pollShellOutputUntilContains = async (
	handlers: ReturnType<typeof createShellTestHandlers>,
	taskId: string,
	substring: string,
): Promise<ShellOutputResult> => {
	const deadline = Date.now() + 1_000;
	let lastResult: ShellOutputResult | null = null;
	while (Date.now() < deadline) {
		const requestId = `shell-output-poll-${Date.now()}`;
		const response = await captureResponse(() => {
			handlers.processMessage({
				jsonrpc: "2.0",
				id: requestId,
				method: "shell.output",
				params: { task_id: taskId, stream: "stdout" },
			} satisfies RpcRequest);
		}, requestId);
		expect(response.error).toBeUndefined();
		lastResult = response.result as ShellOutputResult;
		if (lastResult.content.includes(substring)) {
			return lastResult;
		}
		await Bun.sleep(20);
	}
	throw new Error(
		`timed out waiting for shell output containing ${JSON.stringify(substring)}; last=${JSON.stringify(lastResult)}`,
	);
};

describe("shell.exec rpc", () => {
	test("executes shell command and returns output", async () => {
		const handlers = createShellTestHandlers();

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
		const handlers = createShellTestHandlers();

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
		const handlers = createShellTestHandlers();

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

	test("shell.exec is task-backed and retains a completed shell task", async () => {
		const root = await fs.mkdtemp(
			path.join(os.tmpdir(), "codelia-shell-task-"),
		);
		try {
			const registry = new TaskRegistryStore(path.join(root, "tasks"));
			const taskManager = new TaskManager({
				registry,
				runtimeId: "runtime-shell-test",
				ownerPid: process.pid,
			});
			const handlers = createShellTestHandlers(taskManager);

			const response = await captureResponse(() => {
				handlers.processMessage({
					jsonrpc: "2.0",
					id: "shell-task-backed",
					method: "shell.exec",
					params: {
						command: "printf 'task-backed'",
					},
				} satisfies RpcRequest);
			}, "shell-task-backed");

			expect(response.error).toBeUndefined();
			const tasks = await taskManager.list();
			expect(tasks).toHaveLength(1);
			expect(tasks[0]?.kind).toBe("shell");
			expect(tasks[0]?.state).toBe("completed");
			expect(tasks[0]?.title).toContain("printf");
			expect(tasks[0]?.working_directory).toBe(process.cwd());
			expect(tasks[0]?.result?.stdout).toBe("task-backed");
			expect(tasks[0]?.result?.duration_ms).toBeGreaterThanOrEqual(0);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

describe("shell task rpc", () => {
	test("shell.start -> shell.status -> shell.wait keeps task metadata and returns completion output", async () => {
		const handlers = createShellTestHandlers();
		const startResponse = await captureResponse(() => {
			handlers.processMessage({
				jsonrpc: "2.0",
				id: "shell-start-1",
				method: "shell.start",
				params: {
					command:
						"node -e \"setTimeout(() => { process.stdout.write('async-shell'); }, 150)\"",
					cwd: "packages/runtime",
				},
			} satisfies RpcRequest);
		}, "shell-start-1");

		expect(startResponse.error).toBeUndefined();
		const started = startResponse.result as ShellStartResult;
		expect(started.task_id).toBeTruthy();
		expect(["queued", "running", "completed"]).toContain(started.state);
		expect(started.command_preview).toContain("node -e");
		expect(started.cwd).toBe(path.join(process.cwd(), "packages/runtime"));

		const statusResponse = await captureResponse(() => {
			handlers.processMessage({
				jsonrpc: "2.0",
				id: "shell-status-1",
				method: "shell.status",
				params: { task_id: started.task_id },
			} satisfies RpcRequest);
		}, "shell-status-1");

		expect(statusResponse.error).toBeUndefined();
		const status = statusResponse.result as ShellStartResult;
		expect(status.task_id).toBe(started.task_id);
		expect(status.command_preview).toBe(started.command_preview);
		expect(status.cwd).toBe(started.cwd);

		const waitResponse = await captureResponse(() => {
			handlers.processMessage({
				jsonrpc: "2.0",
				id: "shell-wait-1",
				method: "shell.wait",
				params: { task_id: started.task_id },
			} satisfies RpcRequest);
		}, "shell-wait-1");

		expect(waitResponse.error).toBeUndefined();
		const waited = waitResponse.result as ShellStartResult;
		expect(waited.state).toBe("completed");
		expect(waited.stdout).toBe("async-shell");
		expect(waited.command_preview).toBe(started.command_preview);
		expect(waited.cwd).toBe(started.cwd);
	});

	test("shell.start omits the execution timeout when timeout_seconds is not provided", async () => {
		const logs: string[] = [];
		const handlers = createShellTestHandlers(undefined, logs);
		const startResponse = await captureResponse(() => {
			handlers.processMessage({
				jsonrpc: "2.0",
				id: "shell-start-no-timeout",
				method: "shell.start",
				params: {
					command: "node -e \"setTimeout(() => { process.stdout.write('done'); }, 25)\"",
				},
			} satisfies RpcRequest);
		}, "shell-start-no-timeout");

		expect(startResponse.error).toBeUndefined();
		const started = startResponse.result as ShellStartResult;
		expect(logs.some((message) => message.includes("timeout_s=none"))).toBe(true);

		const waitResponse = await captureResponse(() => {
			handlers.processMessage({
				jsonrpc: "2.0",
				id: "shell-wait-no-timeout",
				method: "shell.wait",
				params: { task_id: started.task_id },
			} satisfies RpcRequest);
		}, "shell-wait-no-timeout");
		expect(waitResponse.error).toBeUndefined();
		expect((waitResponse.result as ShellStartResult).state).toBe("completed");
	});

	test("shell.wait returns still_running when the attached wait window expires", async () => {
		const handlers = createShellTestHandlers();
		const startResponse = await captureResponse(() => {
			handlers.processMessage({
				jsonrpc: "2.0",
				id: "shell-start-still-running",
				method: "shell.start",
				params: {
					command:
						"node -e \"setTimeout(() => { process.stdout.write('late-done'); }, 1500)\"",
				},
			} satisfies RpcRequest);
		}, "shell-start-still-running");

		expect(startResponse.error).toBeUndefined();
		const started = startResponse.result as ShellStartResult;

		const firstWait = await captureResponse(() => {
			handlers.processMessage({
				jsonrpc: "2.0",
				id: "shell-wait-still-running",
				method: "shell.wait",
				params: { task_id: started.task_id, wait_timeout_seconds: 1 },
			} satisfies RpcRequest);
		}, "shell-wait-still-running");

		expect(firstWait.error).toBeUndefined();
		const stillRunning = firstWait.result as ShellStartResult;
		expect(stillRunning.task_id).toBe(started.task_id);
		expect(stillRunning.still_running).toBe(true);
		expect(stillRunning.state).toBe("running");

		const secondWait = await captureResponse(() => {
			handlers.processMessage({
				jsonrpc: "2.0",
				id: "shell-wait-finish-after-window",
				method: "shell.wait",
				params: { task_id: started.task_id, wait_timeout_seconds: 3 },
			} satisfies RpcRequest);
		}, "shell-wait-finish-after-window");

		expect(secondWait.error).toBeUndefined();
		const finished = secondWait.result as ShellStartResult;
		expect(finished.still_running).toBeUndefined();
		expect(finished.state).toBe("completed");
		expect(finished.stdout).toBe("late-done");
	});

	test("shell.start rejects background timeouts beyond Node timer range", async () => {
		const handlers = createShellTestHandlers();
		const response = await captureResponse(() => {
			handlers.processMessage({
				jsonrpc: "2.0",
				id: "shell-start-timeout-overflow",
				method: "shell.start",
				params: {
					command: "printf overflow",
					timeout_seconds: MAX_EXECUTION_TIMEOUT_SECONDS + 1,
				},
			} satisfies RpcRequest);
		}, "shell-start-timeout-overflow");

		expect(response.result).toBeUndefined();
		expect(response.error?.code).toBe(RPC_ERROR_CODE.INVALID_PARAMS);
		expect(response.error?.message).toContain("background timeout_seconds must be");
	});

	test("shell.cancel cancels a running task and shell.list includes the retained shell task", async () => {
		const handlers = createShellTestHandlers();
		const startResponse = await captureResponse(() => {
			handlers.processMessage({
				jsonrpc: "2.0",
				id: "shell-start-2",
				method: "shell.start",
				params: {
					command: 'node -e "setInterval(() => {}, 1000)"',
				},
			} satisfies RpcRequest);
		}, "shell-start-2");

		expect(startResponse.error).toBeUndefined();
		const started = startResponse.result as ShellStartResult;

		const cancelResponse = await captureResponse(() => {
			handlers.processMessage({
				jsonrpc: "2.0",
				id: "shell-cancel-1",
				method: "shell.cancel",
				params: { task_id: started.task_id },
			} satisfies RpcRequest);
		}, "shell-cancel-1");

		expect(cancelResponse.error).toBeUndefined();
		const cancelled = cancelResponse.result as ShellStartResult;
		expect(cancelled.task_id).toBe(started.task_id);
		expect(cancelled.state).toBe("cancelled");
		expect(cancelled.cancellation_reason).toBe("cancelled");

		const listResponse = await captureResponse(() => {
			handlers.processMessage({
				jsonrpc: "2.0",
				id: "shell-list-1",
				method: "shell.list",
				params: { limit: 5 },
			} satisfies RpcRequest);
		}, "shell-list-1");

		expect(listResponse.error).toBeUndefined();
		const listed = listResponse.result as ShellListResult;
		expect(listed.tasks.some((task) => task.task_id === started.task_id)).toBe(
			true,
		);
		expect(
			listed.tasks.find((task) => task.task_id === started.task_id)?.state,
		).toBe("cancelled");
	});

	test("shell.output returns inline retained output for small completed tasks", async () => {
		const handlers = createShellTestHandlers();
		const startResponse = await captureResponse(() => {
			handlers.processMessage({
				jsonrpc: "2.0",
				id: "shell-start-inline-output",
				method: "shell.start",
				params: { command: "printf 'inline-output'" },
			} satisfies RpcRequest);
		}, "shell-start-inline-output");

		expect(startResponse.error).toBeUndefined();
		const started = startResponse.result as ShellStartResult;

		await captureResponse(() => {
			handlers.processMessage({
				jsonrpc: "2.0",
				id: "shell-wait-inline-output",
				method: "shell.wait",
				params: { task_id: started.task_id },
			} satisfies RpcRequest);
		}, "shell-wait-inline-output");

		const outputResponse = await captureResponse(() => {
			handlers.processMessage({
				jsonrpc: "2.0",
				id: "shell-output-inline",
				method: "shell.output",
				params: { task_id: started.task_id, stream: "stdout" },
			} satisfies RpcRequest);
		}, "shell-output-inline");

		expect(outputResponse.error).toBeUndefined();
		const output = outputResponse.result as ShellOutputResult;
		expect(output.cached).toBe(false);
		expect(output.content).toContain("inline-output");
	});

	test("shell.output reads cache-backed output for truncated completed tasks", async () => {
		const handlers = createShellTestHandlers();
		const startResponse = await captureResponse(() => {
			handlers.processMessage({
				jsonrpc: "2.0",
				id: "shell-start-cached-output",
				method: "shell.start",
				params: {
					command:
						"node -e \"for (let i = 1; i <= 250; i += 1) console.log('line-' + i)\"",
				},
			} satisfies RpcRequest);
		}, "shell-start-cached-output");

		expect(startResponse.error).toBeUndefined();
		const started = startResponse.result as ShellStartResult;

		const waitResponse = await captureResponse(() => {
			handlers.processMessage({
				jsonrpc: "2.0",
				id: "shell-wait-cached-output",
				method: "shell.wait",
				params: { task_id: started.task_id },
			} satisfies RpcRequest);
		}, "shell-wait-cached-output");

		expect(waitResponse.error).toBeUndefined();
		const waited = waitResponse.result as ShellStartResult;
		expect(waited.truncated.stdout).toBe(true);

		const outputResponse = await captureResponse(() => {
			handlers.processMessage({
				jsonrpc: "2.0",
				id: "shell-output-cached",
				method: "shell.output",
				params: {
					task_id: started.task_id,
					stream: "stdout",
					offset: 240,
					limit: 3,
				},
			} satisfies RpcRequest);
		}, "shell-output-cached");

		expect(outputResponse.error).toBeUndefined();
		const output = outputResponse.result as ShellOutputResult;
		expect(output.cached).toBe(true);
		expect(output.ref_id).toBeTruthy();
		expect(output.content).toContain("line-241");
		expect(output.content).toContain("line-243");
	});

	test("shell.output rejects invalid paging combinations and can read running output", async () => {
		const handlers = createShellTestHandlers();
		const invalidResponse = await captureResponse(() => {
			handlers.processMessage({
				jsonrpc: "2.0",
				id: "shell-output-invalid",
				method: "shell.output",
				params: {
					task_id: "task-1",
					stream: "stdout",
					char_offset: 1,
				},
			} satisfies RpcRequest);
		}, "shell-output-invalid");

		expect(invalidResponse.error).toEqual(
			expect.objectContaining({
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: "char_offset/char_limit require line_number",
			}),
		);

		const startResponse = await captureResponse(() => {
			handlers.processMessage({
				jsonrpc: "2.0",
				id: "shell-start-running-output",
				method: "shell.start",
				params: {
					command:
						"node -e \"process.stdout.write('live-now\\n'); setTimeout(() => { process.stdout.write('live-later'); }, 500)\"",
				},
			} satisfies RpcRequest);
		}, "shell-start-running-output");

		expect(startResponse.error).toBeUndefined();
		const started = startResponse.result as ShellStartResult;
		const output = await pollShellOutputUntilContains(
			handlers,
			started.task_id,
			"live-now",
		);
		expect(output.cached).toBe(false);

		const finalWaitResponse = await captureResponse(() => {
			handlers.processMessage({
				jsonrpc: "2.0",
				id: "shell-wait-running-output",
				method: "shell.wait",
				params: { task_id: started.task_id },
			} satisfies RpcRequest);
		}, "shell-wait-running-output");

		expect(finalWaitResponse.error).toBeUndefined();
		const finished = finalWaitResponse.result as ShellStartResult;
		expect(finished.state).toBe("completed");
		expect(finished.stdout).toContain("live-later");
	});

	test("shell.detach releases an active wait without cancelling the task", async () => {
		const handlers = createShellTestHandlers();
		const startResponse = await captureResponse(() => {
			handlers.processMessage({
				jsonrpc: "2.0",
				id: "shell-start-detach",
				method: "shell.start",
				params: {
					command:
						"node -e \"process.stdout.write('detached-live\\n'); setTimeout(() => { process.stdout.write('detached-done'); }, 250)\"",
				},
			} satisfies RpcRequest);
		}, "shell-start-detach");

		expect(startResponse.error).toBeUndefined();
		const started = startResponse.result as ShellStartResult;

		const responses = await captureResponses(async () => {
			handlers.processMessage({
				jsonrpc: "2.0",
				id: "shell-wait-detach",
				method: "shell.wait",
				params: { task_id: started.task_id },
			} satisfies RpcRequest);
			await Bun.sleep(30);
			handlers.processMessage({
				jsonrpc: "2.0",
				id: "shell-detach-1",
				method: "shell.detach",
				params: { task_id: started.task_id },
			} satisfies RpcRequest);
		}, ["shell-wait-detach", "shell-detach-1"]);

		const detachResponse = responses.get("shell-detach-1");
		const waitResponse = responses.get("shell-wait-detach");
		expect(detachResponse?.error).toBeUndefined();
		expect(waitResponse?.error).toBeUndefined();
		const detached = detachResponse?.result as ShellDetachResult;
		const waitDetached = waitResponse?.result as ShellDetachResult;
		expect(detached.detached).toBe(true);
		expect(detached.task_id).toBe(started.task_id);
		expect(waitDetached.detached).toBe(true);
		expect(waitDetached.task_id).toBe(started.task_id);

		const liveOutput = await pollShellOutputUntilContains(
			handlers,
			started.task_id,
			"detached-live",
		);
		expect(liveOutput.content).toContain("detached-live");

		const finalWaitResponse = await captureResponse(() => {
			handlers.processMessage({
				jsonrpc: "2.0",
				id: "shell-wait-after-detach",
				method: "shell.wait",
				params: { task_id: started.task_id },
			} satisfies RpcRequest);
		}, "shell-wait-after-detach");

		expect(finalWaitResponse.error).toBeUndefined();
		const finished = finalWaitResponse.result as ShellStartResult;
		expect(finished.state).toBe("completed");
		expect(finished.stdout).toContain("detached-live");
		expect(finished.stdout).toContain("detached-done");
	});

	test("shell.detach rejects tasks without an active wait", async () => {
		const handlers = createShellTestHandlers();
		const startResponse = await captureResponse(() => {
			handlers.processMessage({
				jsonrpc: "2.0",
				id: "shell-start-no-active-wait",
				method: "shell.start",
				params: {
					command:
						"node -e \"setTimeout(() => { process.stdout.write('done'); }, 200)\"",
				},
			} satisfies RpcRequest);
		}, "shell-start-no-active-wait");

		expect(startResponse.error).toBeUndefined();
		const started = startResponse.result as ShellStartResult;

		const response = await captureResponse(() => {
			handlers.processMessage({
				jsonrpc: "2.0",
				id: "shell-detach-no-active-wait",
				method: "shell.detach",
				params: { task_id: started.task_id },
			} satisfies RpcRequest);
		}, "shell-detach-no-active-wait");

		expect(response.error).toEqual(
			expect.objectContaining({
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: `no active shell.wait to detach for task: ${started.task_id}`,
			}),
		);

		await captureResponse(() => {
			handlers.processMessage({
				jsonrpc: "2.0",
				id: "shell-wait-no-active-wait",
				method: "shell.wait",
				params: { task_id: started.task_id },
			} satisfies RpcRequest);
		}, "shell-wait-no-active-wait");
	});

	test("initialize advertises shell task support", async () => {
		const handlers = createShellTestHandlers();
		const response = await captureResponse(() => {
			handlers.processMessage({
				jsonrpc: "2.0",
				id: "initialize-shell-tasks",
				method: "initialize",
				params: {
					protocol_version: "0",
					client: { name: "test", version: "0.0.0" },
				},
			} satisfies RpcRequest);
		}, "initialize-shell-tasks");

		expect(response.error).toBeUndefined();
		const result = response.result as InitializeResult;
		expect(result.server_capabilities?.supports_shell_exec).toBe(true);
		expect(result.server_capabilities?.supports_shell_tasks).toBe(true);
		expect(result.server_capabilities?.supports_shell_detach).toBe(true);
		expect(result.server_capabilities?.supports_tasks).toBe(true);
	});
});
