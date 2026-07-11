import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DependencyKey, ToolContext, ToolDefinition } from "@codelia/core";
import {
	resolveStoragePaths,
	TaskRegistryStore,
	ToolOutputCacheStoreImpl,
} from "@codelia/storage";
import { createSandboxKey, SandboxContext } from "../src/sandbox/context";
import { TaskManager } from "../src/tasks";
import { createTools } from "../src/tools";
import {
	DEFAULT_TIMEOUT_SECONDS,
	MAX_EXECUTION_TIMEOUT_SECONDS,
	MAX_TIMEOUT_SECONDS,
} from "../src/tools/bash-utils";
import { createToolSessionContextKey } from "../src/tools/session-context";
import {
	createShellCancelTool,
	createShellListTool,
	createShellLogsTool,
	createShellResultTool,
	createShellStatusTool,
	createShellStdinWriteTool,
	createShellTool,
	createShellWaitTool,
} from "../src/tools/shell";

const createTempDir = async (prefix: string): Promise<string> =>
	fs.mkdtemp(path.join(os.tmpdir(), prefix));

const createToolContext = (): ToolContext => {
	const cache = new Map<string, unknown>();
	const deps: Record<string, unknown> = Object.create(null);
	return {
		deps,
		resolve: async <T>(key: DependencyKey<T>): Promise<T> => {
			if (cache.has(key.id)) {
				return cache.get(key.id) as T;
			}
			const value = await key.create();
			cache.set(key.id, value);
			return value;
		},
	};
};

const expectJsonResult = (result: unknown): Record<string, unknown> => {
	if (
		typeof result !== "object" ||
		result === null ||
		!("type" in result) ||
		(result as { type: string }).type !== "json"
	) {
		throw new Error("unexpected tool result");
	}
	const value = (result as { value?: unknown }).value;
	if (typeof value !== "object" || value === null) {
		throw new Error("unexpected tool result");
	}
	return value as Record<string, unknown>;
};

const expectStringField = (
	value: Record<string, unknown>,
	field: string,
): string => {
	const text = value[field];
	if (typeof text !== "string") {
		throw new Error(`missing string field: ${field}`);
	}
	return text;
};

const isFunctionToolDefinition = (
	value: ToolDefinition,
): value is ToolDefinition & {
	description: string;
	parameters: unknown;
} => "parameters" in value && "description" in value;

const LIVE_OUTPUT_WAIT_TIMEOUT_MS = 3_000;
const LIVE_OUTPUT_POLL_INTERVAL_MS = 25;

const waitForLiveValue = async <T>(options: {
	read: () => Promise<T>;
	isReady: (value: T) => boolean;
	description: string;
}): Promise<T> => {
	const deadline = performance.now() + LIVE_OUTPUT_WAIT_TIMEOUT_MS;
	while (true) {
		const value = await options.read();
		if (options.isReady(value)) return value;
		if (performance.now() >= deadline) {
			throw new Error(
				`Timed out after ${LIVE_OUTPUT_WAIT_TIMEOUT_MS}ms waiting for ${options.description}`,
			);
		}
		await Bun.sleep(LIVE_OUTPUT_POLL_INTERVAL_MS);
	}
};

describe("shell tools", () => {
	test("createTools registers the dedicated shell tool family", async () => {
		const tempRoot = await createTempDir("codelia-shell-tool-");
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const tools = createTools(
				createSandboxKey(sandbox),
				{
					id: "agents-test",
					create: async () => ({}) as never,
				},
				{
					id: "skills-test",
					create: async () => ({}) as never,
				},
			);
			const names = tools.map((tool) => tool.definition.name);
			expect(names).toEqual(
				expect.arrayContaining([
					"shell",
					"shell_list",
					"shell_status",
					"shell_logs",
					"shell_wait",
					"shell_result",
					"shell_cancel",
					"shell_stdin_write",
				]),
			);
			expect(names).not.toContain("grep");
			expect(names).not.toContain("glob_search");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("shell stdin requires a detached pipe and enforces bounded non-empty writes", async () => {
		const tempRoot = await createTempDir("codelia-shell-tool-");
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const shellTool = createShellTool(createSandboxKey(sandbox));
			expect(() =>
				shellTool.executeRaw(
					JSON.stringify({ command: "cat", stdin_mode: "pipe" }),
					createToolContext(),
				),
			).toThrow("stdin_mode=pipe requires detached_wait=true");

			const stdinTool = createShellStdinWriteTool();
			expect(() =>
				stdinTool.executeRaw(
					JSON.stringify({ key: "shell-test", text: "" }),
					createToolContext(),
				),
			).toThrow("text must be non-empty unless close=true");
			expect(() =>
				stdinTool.executeRaw(
					JSON.stringify({ key: "shell-test", text: "x".repeat(65_537) }),
					createToolContext(),
				),
			).toThrow("limited to 65536 UTF-8 bytes");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("shell_stdin_write drives a line-oriented process and enforces session ownership", async () => {
		const tempRoot = await createTempDir("codelia-shell-tool-");
		const storageRoot = path.join(tempRoot, "storage");
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const storagePaths = resolveStoragePaths({ rootOverride: storageRoot });
			const taskManager = new TaskManager({
				registry: new TaskRegistryStore(path.join(storageRoot, "tasks")),
			});
			const sessionOne = createToolSessionContextKey(() => "session-stdin-1");
			const sessionTwo = createToolSessionContextKey(() => "session-stdin-2");
			const options = {
				taskManager,
				outputCacheStore: new ToolOutputCacheStoreImpl({ paths: storagePaths }),
			};
			const shellTool = createShellTool(createSandboxKey(sandbox), {
				...options,
				sessionContextKey: sessionOne,
			});
			const start = expectJsonResult(
				await shellTool.executeRaw(
					JSON.stringify({
						command: `node -e "process.stdin.setEncoding('utf8');let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write(s.toUpperCase()))"`,
						detached_wait: true,
						stdin_mode: "pipe",
					}),
					createToolContext(),
				),
			);
			const key = expectStringField(start, "key");
			const wrongSessionTool = createShellStdinWriteTool({
				...options,
				sessionContextKey: sessionTwo,
			});
			await expect(
				wrongSessionTool.executeRaw(
					JSON.stringify({ key, text: "wrong" }),
					createToolContext(),
				),
			).rejects.toThrow("task_owned_by_other_session");

			const stdinTool = createShellStdinWriteTool({
				...options,
				sessionContextKey: sessionOne,
			});
			const write = expectJsonResult(
				await stdinTool.executeRaw(
					JSON.stringify({
						key,
						text: "hello",
						append_newline: true,
						close: true,
					}),
					createToolContext(),
				),
			);
			expect(write.key).toBe(key);
			expect(["running", "completed"]).toContain(String(write.state));
			expect(write.bytes_written).toBe(6);
			expect(write.stdin_closed).toBe(true);
			const task = (await taskManager.list()).find(
				(candidate) => candidate.key === key,
			);
			if (!task) throw new Error("missing shell task");
			const settled = await taskManager.wait(task.task_id);
			expect(settled.state).toBe("completed");
			expect(settled.result?.stdout).toBe("HELLO\n");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("shell follow-up tool schemas use a provider-compatible top-level key object", async () => {
		const tempRoot = await createTempDir("codelia-shell-tool-");
		try {
			const shellStatusTool = createShellStatusTool();
			const shellLogsTool = createShellLogsTool();
			const statusParams = (
				shellStatusTool.definition as { parameters: unknown }
			).parameters as Record<string, unknown>;
			expect(statusParams.type).toBe("object");
			expect(statusParams.anyOf).toBeUndefined();
			expect(statusParams.oneOf).toBeUndefined();
			expect(statusParams.required).toEqual(["key"]);

			const logsParams = (shellLogsTool.definition as { parameters: unknown })
				.parameters as Record<string, unknown>;
			expect(logsParams.type).toBe("object");
			expect(logsParams.anyOf).toBeUndefined();
			expect(logsParams.oneOf).toBeUndefined();
			expect(logsParams.required).toContain("key");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("shell schema explains foreground/detached-wait timeout behavior", async () => {
		const shellTool = createShellTool({
			id: "sandbox-test",
			create: async () => {
				throw new Error("not used");
			},
		});
		const definition = shellTool.definition;
		expect(isFunctionToolDefinition(definition)).toBe(true);
		if (!isFunctionToolDefinition(definition)) {
			throw new Error("shell tool must be a function tool");
		}
		expect(definition.description).toContain(
			"waits with stdin closed by default",
		);
		expect(definition.description).toContain("detached_wait");
		expect(definition.description).toContain("managed child process");
		const parameters = definition.parameters as Record<string, unknown>;
		const properties = (parameters.properties ?? {}) as Record<
			string,
			Record<string, unknown>
		>;
		const commandDescription = properties.command?.description;
		expect(typeof commandDescription).toBe("string");
		expect(String(commandDescription)).toContain(
			"runtime-managed child process",
		);
		const timeoutDescription = properties.timeout?.description;
		expect(typeof timeoutDescription).toBe("string");
		expect(String(timeoutDescription)).toContain("default 120, max 300");
		expect(String(timeoutDescription)).toContain("Detached: max");
		expect(String(timeoutDescription)).toContain(
			String(MAX_EXECUTION_TIMEOUT_SECONDS),
		);
		expect(String(timeoutDescription)).toContain("omit");
		const includeDescription =
			properties.include_stderr_on_success?.description;
		expect(typeof includeDescription).toBe("string");
		expect(String(includeDescription)).toContain("Include stderr on success");
		expect(String(includeDescription)).toContain("Default: false");
		const detachedWaitDescription = properties.detached_wait?.description;
		expect(typeof detachedWaitDescription).toBe("string");
		expect(String(detachedWaitDescription)).toContain("Return a task key");
		expect(String(detachedWaitDescription)).toContain("runtime owns the child");
		expect(String(detachedWaitDescription)).toContain("runtime exit");
		expect(String(detachedWaitDescription)).toContain("follow-up shell tools");
		const stdinModeDescription = properties.stdin_mode?.description;
		expect(typeof stdinModeDescription).toBe("string");
		expect(String(stdinModeDescription)).toContain("closed (default)");
		expect(String(stdinModeDescription)).toContain("detached_wait=true");
		expect(String(stdinModeDescription)).toContain("shell_stdin_write");
	});

	test("shell_wait schema explains bounded wait-window behavior", async () => {
		const shellWaitTool = createShellWaitTool();
		const definition = shellWaitTool.definition;
		expect(isFunctionToolDefinition(definition)).toBe(true);
		if (!isFunctionToolDefinition(definition)) {
			throw new Error("shell_wait tool must be a function tool");
		}
		expect(definition.description).toContain("bounded window");
		expect(definition.description).toContain("running status");
		const parameters = definition.parameters as Record<string, unknown>;
		const properties = (parameters.properties ?? {}) as Record<
			string,
			Record<string, unknown>
		>;
		const waitTimeoutDescription = properties.wait_timeout?.description;
		expect(typeof waitTimeoutDescription).toBe("string");
		expect(String(waitTimeoutDescription)).toContain(
			`Default: ${DEFAULT_TIMEOUT_SECONDS}`,
		);
		expect(String(waitTimeoutDescription)).toContain(
			`Max ${MAX_TIMEOUT_SECONDS}`,
		);
		expect(String(waitTimeoutDescription)).toContain("compact status JSON");
		const includeDescription =
			properties.include_stderr_on_success?.description;
		expect(typeof includeDescription).toBe("string");
		expect(String(includeDescription)).toContain("Include stderr on success");
	});

	test("shell_result schema explains retained terminal stderr suppression override", async () => {
		const shellResultTool = createShellResultTool();
		const definition = shellResultTool.definition;
		expect(isFunctionToolDefinition(definition)).toBe(true);
		if (!isFunctionToolDefinition(definition)) {
			throw new Error("shell_result tool must be a function tool");
		}
		expect(definition.description).toContain("retained terminal stdout/stderr");
		expect(definition.description).toContain("still running");
		const parameters = definition.parameters as Record<string, unknown>;
		const properties = (parameters.properties ?? {}) as Record<
			string,
			Record<string, unknown>
		>;
		const includeDescription =
			properties.include_stderr_on_success?.description;
		expect(typeof includeDescription).toBe("string");
		expect(String(includeDescription)).toContain("Include stderr on success");
		expect(String(includeDescription)).toContain("Default: false");
	});

	test("shell rejects detached-wait timeouts beyond Node timer range", async () => {
		const tempRoot = await createTempDir("codelia-shell-tool-");
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const shellTool = createShellTool(createSandboxKey(sandbox));
			expect(() =>
				shellTool.executeRaw(
					JSON.stringify({
						command: "printf overflow",
						detached_wait: true,
						timeout: MAX_EXECUTION_TIMEOUT_SECONDS + 1,
					}),
					createToolContext(),
				),
			).toThrow("Detached-wait timeout must be");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("shell waits by default and returns compact terminal JSON", async () => {
		const tempRoot = await createTempDir("codelia-shell-tool-");
		const storageRoot = path.join(tempRoot, "storage");
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const storagePaths = resolveStoragePaths({ rootOverride: storageRoot });
			const taskManager = new TaskManager({
				registry: new TaskRegistryStore(path.join(storageRoot, "tasks")),
			});
			const shellTool = createShellTool(createSandboxKey(sandbox), {
				taskManager,
				outputCacheStore: new ToolOutputCacheStoreImpl({ paths: storagePaths }),
				sessionContextKey: createToolSessionContextKey(() => "session-shell-1"),
			});

			const result = await shellTool.executeRaw(
				JSON.stringify({
					command: `node -e "process.stdout.write('hello-shell')"`,
				}),
				createToolContext(),
			);
			const value = expectJsonResult(result);
			expect(shellTool.definition.name).toBe("shell");
			expect(value.state).toBe("completed");
			expect(value.exit_code).toBe(0);
			expect(value.stdout).toBe("hello-shell");
			expect(value.stderr).toBeUndefined();
			const key = expectStringField(value, "key");
			expect(key).toMatch(/^shell-/);

			const tasks = await taskManager.list();
			expect(tasks).toHaveLength(1);
			expect(tasks[0]?.parent_session_id).toBe("session-shell-1");
			expect(tasks[0]?.key).toBe(key);
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("shell foreground run tolerates ESRCH from stale-task reconciliation", async () => {
		const tempRoot = await createTempDir("codelia-shell-tool-");
		const storageRoot = path.join(tempRoot, "storage");
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const storagePaths = resolveStoragePaths({ rootOverride: storageRoot });
			const registry = new TaskRegistryStore(path.join(storageRoot, "tasks"));
			const err = new Error("No such process") as Error & { code?: string };
			err.code = "ESRCH";
			const taskManager = new TaskManager({
				registry,
				runtimeId: "runtime-test",
				ownerPid: 5000,
				processController: {
					isProcessAlive: async () => false,
					terminateProcess: async () => {
						throw err;
					},
					terminateProcessGroup: async () => {
						throw err;
					},
				},
			});
			await registry.upsert({
				version: 1,
				task_id: "stale-orphan-task",
				kind: "shell",
				workspace_mode: "live_workspace",
				state: "running",
				owner_runtime_id: "dead-runtime",
				owner_pid: 9999,
				executor_pid: 7001,
				executor_pgid: 7007,
				created_at: "2026-03-08T10:00:00.000Z",
				updated_at: "2026-03-08T10:01:00.000Z",
				started_at: "2026-03-08T10:00:10.000Z",
			});
			const shellTool = createShellTool(createSandboxKey(sandbox), {
				taskManager,
				outputCacheStore: new ToolOutputCacheStoreImpl({ paths: storagePaths }),
			});

			const result = await shellTool.executeRaw(
				JSON.stringify({ command: `node -e "process.stdout.write('ok')"` }),
				createToolContext(),
			);
			const value = expectJsonResult(result);
			expect(value.state).toBe("completed");
			expect(value.stdout).toBe("ok");
			expect(value.stderr).toBeUndefined();
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("shell_status and shell_wait inspect a detached-wait shell task", async () => {
		const tempRoot = await createTempDir("codelia-shell-tool-");
		const storageRoot = path.join(tempRoot, "storage");
		let taskManager: TaskManager | null = null;
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const storagePaths = resolveStoragePaths({ rootOverride: storageRoot });
			taskManager = new TaskManager({
				registry: new TaskRegistryStore(path.join(storageRoot, "tasks")),
			});
			const shellTool = createShellTool(createSandboxKey(sandbox), {
				taskManager,
				outputCacheStore: new ToolOutputCacheStoreImpl({ paths: storagePaths }),
			});
			const shellStatusTool = createShellStatusTool({
				taskManager,
				outputCacheStore: new ToolOutputCacheStoreImpl({ paths: storagePaths }),
			});
			const shellLogsTool = createShellLogsTool({
				taskManager,
				outputCacheStore: new ToolOutputCacheStoreImpl({ paths: storagePaths }),
			});
			const shellWaitTool = createShellWaitTool({
				taskManager,
				outputCacheStore: new ToolOutputCacheStoreImpl({ paths: storagePaths }),
			});
			const shellResultTool = createShellResultTool({
				taskManager,
				outputCacheStore: new ToolOutputCacheStoreImpl({ paths: storagePaths }),
			});

			const start = expectJsonResult(
				await shellTool.executeRaw(
					JSON.stringify({
						command: `node -e "process.stdout.write('start\\n'); setTimeout(() => { process.stdout.write('finish'); }, 150)"`,
						detached_wait: true,
					}),
					createToolContext(),
				),
			);
			const taskKey = expectStringField(start, "key");
			expect(taskKey).toMatch(/^shell-/);
			expect(["queued", "running"]).toContain(String(start.state));
			expect(start.detached_wait).toBe(true);

			const status = expectJsonResult(
				await shellStatusTool.executeRaw(
					JSON.stringify({ key: taskKey }),
					createToolContext(),
				),
			);
			expect(status.key).toBe(taskKey);
			expect(["queued", "running"]).toContain(String(status.state));
			expect(status.stdout).toBeUndefined();
			expect(status.stderr).toBeUndefined();

			const liveLogs = await waitForLiveValue({
				read: async () =>
					expectJsonResult(
						await shellLogsTool.executeRaw(
							JSON.stringify({ key: taskKey, stream: "stdout" }),
							createToolContext(),
						),
					),
				isReady: (value) => String(value.content).includes("start"),
				description: "initial detached stdout",
			});
			expect(liveLogs.live).toBe(true);
			expect(String(liveLogs.content)).toContain("start");

			const waited = expectJsonResult(
				await shellWaitTool.executeRaw(
					JSON.stringify({ key: taskKey }),
					createToolContext(),
				),
			);
			expect(waited.key).toBe(taskKey);
			expect(waited.state).toBe("completed");
			expect(waited.exit_code).toBe(0);
			expect(waited.stdout).toBe("start\nfinish");
			expect(waited.stderr).toBeUndefined();

			const retained = expectJsonResult(
				await shellResultTool.executeRaw(
					JSON.stringify({ key: taskKey }),
					createToolContext(),
				),
			);
			expect(retained.key).toBe(taskKey);
			expect(retained.state).toBe("completed");
			expect(retained.stdout).toBe("start\nfinish");
			expect(retained.stderr).toBeUndefined();
		} finally {
			await taskManager?.shutdown();
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("shell_wait returns still_running when the wait window expires first", async () => {
		const tempRoot = await createTempDir("codelia-shell-tool-");
		const storageRoot = path.join(tempRoot, "storage");
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const storagePaths = resolveStoragePaths({ rootOverride: storageRoot });
			const taskManager = new TaskManager({
				registry: new TaskRegistryStore(path.join(storageRoot, "tasks")),
			});
			const outputCacheStore = new ToolOutputCacheStoreImpl({
				paths: storagePaths,
			});
			const shellTool = createShellTool(createSandboxKey(sandbox), {
				taskManager,
				outputCacheStore,
			});
			const shellWaitTool = createShellWaitTool({
				taskManager,
				outputCacheStore,
			});

			const start = expectJsonResult(
				await shellTool.executeRaw(
					JSON.stringify({
						command: `node -e "setTimeout(() => { process.stdout.write('done'); }, 1500)"`,
						detached_wait: true,
					}),
					createToolContext(),
				),
			);
			const taskKey = expectStringField(start, "key");

			const firstWait = expectJsonResult(
				await shellWaitTool.executeRaw(
					JSON.stringify({ key: taskKey, wait_timeout: 1 }),
					createToolContext(),
				),
			);
			expect(firstWait.key).toBe(taskKey);
			expect(["queued", "running"]).toContain(String(firstWait.state));
			expect(firstWait.still_running).toBe(true);
			expect(firstWait.stdout).toBeUndefined();
			expect(firstWait.stderr).toBeUndefined();

			const secondWait = expectJsonResult(
				await shellWaitTool.executeRaw(
					JSON.stringify({ key: taskKey, wait_timeout: 3 }),
					createToolContext(),
				),
			);
			expect(secondWait.key).toBe(taskKey);
			expect(secondWait.state).toBe("completed");
			expect(secondWait.exit_code).toBe(0);
			expect(secondWait.stdout).toBe("done");
			expect(secondWait.stderr).toBeUndefined();
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("shell_wait and shell_result preserve failed state and return both streams when available", async () => {
		const tempRoot = await createTempDir("codelia-shell-tool-");
		const storageRoot = path.join(tempRoot, "storage");
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const storagePaths = resolveStoragePaths({ rootOverride: storageRoot });
			const outputCacheStore = new ToolOutputCacheStoreImpl({
				paths: storagePaths,
			});
			const taskManager = new TaskManager({
				registry: new TaskRegistryStore(path.join(storageRoot, "tasks")),
			});
			const shellTool = createShellTool(createSandboxKey(sandbox), {
				taskManager,
				outputCacheStore,
			});
			const shellWaitTool = createShellWaitTool({
				taskManager,
				outputCacheStore,
			});
			const shellResultTool = createShellResultTool({
				taskManager,
				outputCacheStore,
			});

			const start = expectJsonResult(
				await shellTool.executeRaw(
					JSON.stringify({
						command: `node -e "process.stdout.write('before-fail'); process.stderr.write('boom'); process.exit(7)"`,
						detached_wait: true,
					}),
					createToolContext(),
				),
			);
			const taskKey = expectStringField(start, "key");

			const waited = expectJsonResult(
				await shellWaitTool.executeRaw(
					JSON.stringify({ key: taskKey, wait_timeout: 3 }),
					createToolContext(),
				),
			);
			expect(waited.key).toBe(taskKey);
			expect(waited.state).toBe("failed");
			expect(waited.exit_code).toBe(7);
			expect(String(waited.stdout)).toContain("before-fail");
			expect(String(waited.stderr)).toContain("boom");

			const retained = expectJsonResult(
				await shellResultTool.executeRaw(
					JSON.stringify({ key: taskKey }),
					createToolContext(),
				),
			);
			expect(retained.key).toBe(taskKey);
			expect(retained.state).toBe("failed");
			expect(retained.exit_code).toBe(7);
			expect(String(retained.stdout)).toContain("before-fail");
			expect(String(retained.stderr)).toContain("boom");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("successful terminal payload suppresses stderr while shell_logs can still read it", async () => {
		const tempRoot = await createTempDir("codelia-shell-tool-");
		const storageRoot = path.join(tempRoot, "storage");
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const storagePaths = resolveStoragePaths({ rootOverride: storageRoot });
			const outputCacheStore = new ToolOutputCacheStoreImpl({
				paths: storagePaths,
			});
			const taskManager = new TaskManager({
				registry: new TaskRegistryStore(path.join(storageRoot, "tasks")),
			});
			const shellTool = createShellTool(createSandboxKey(sandbox), {
				taskManager,
				outputCacheStore,
			});
			const shellLogsTool = createShellLogsTool({
				taskManager,
				outputCacheStore,
			});

			const result = expectJsonResult(
				await shellTool.executeRaw(
					JSON.stringify({
						command: `node -e "process.stdout.write('ok'); process.stderr.write('warn');"`,
					}),
					createToolContext(),
				),
			);
			const taskKey = expectStringField(result, "key");
			expect(result.state).toBe("completed");
			expect(result.stdout).toBe("ok");
			expect(result.stderr).toBeUndefined();

			const stderrLogs = expectJsonResult(
				await shellLogsTool.executeRaw(
					JSON.stringify({ key: taskKey, stream: "stderr" }),
					createToolContext(),
				),
			);
			expect(stderrLogs.live).toBe(false);
			expect(stderrLogs.stream).toBe("stderr");
			expect(String(stderrLogs.content)).toContain("warn");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("shell can include success stderr when include_stderr_on_success is true", async () => {
		const tempRoot = await createTempDir("codelia-shell-tool-");
		const storageRoot = path.join(tempRoot, "storage");
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const storagePaths = resolveStoragePaths({ rootOverride: storageRoot });
			const shellTool = createShellTool(createSandboxKey(sandbox), {
				taskManager: new TaskManager({
					registry: new TaskRegistryStore(path.join(storageRoot, "tasks")),
				}),
				outputCacheStore: new ToolOutputCacheStoreImpl({ paths: storagePaths }),
			});

			const result = expectJsonResult(
				await shellTool.executeRaw(
					JSON.stringify({
						command: `node -e "process.stdout.write('ok'); process.stderr.write('warn');"`,
						include_stderr_on_success: true,
					}),
					createToolContext(),
				),
			);
			expect(result.state).toBe("completed");
			expect(result.stdout).toBe("ok");
			expect(String(result.stderr)).toContain("warn");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("shell_wait and shell_result can include success stderr when include_stderr_on_success is true", async () => {
		const tempRoot = await createTempDir("codelia-shell-tool-");
		const storageRoot = path.join(tempRoot, "storage");
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const storagePaths = resolveStoragePaths({ rootOverride: storageRoot });
			const outputCacheStore = new ToolOutputCacheStoreImpl({
				paths: storagePaths,
			});
			const taskManager = new TaskManager({
				registry: new TaskRegistryStore(path.join(storageRoot, "tasks")),
			});
			const shellTool = createShellTool(createSandboxKey(sandbox), {
				taskManager,
				outputCacheStore,
			});
			const shellWaitTool = createShellWaitTool({
				taskManager,
				outputCacheStore,
			});
			const shellResultTool = createShellResultTool({
				taskManager,
				outputCacheStore,
			});

			const start = expectJsonResult(
				await shellTool.executeRaw(
					JSON.stringify({
						command: `node -e "process.stdout.write('ok'); process.stderr.write('warn');"`,
						detached_wait: true,
					}),
					createToolContext(),
				),
			);
			const taskKey = expectStringField(start, "key");

			const waited = expectJsonResult(
				await shellWaitTool.executeRaw(
					JSON.stringify({
						key: taskKey,
						include_stderr_on_success: true,
					}),
					createToolContext(),
				),
			);
			expect(waited.state).toBe("completed");
			expect(waited.stdout).toBe("ok");
			expect(String(waited.stderr)).toContain("warn");

			const retained = expectJsonResult(
				await shellResultTool.executeRaw(
					JSON.stringify({
						key: taskKey,
						include_stderr_on_success: true,
					}),
					createToolContext(),
				),
			);
			expect(retained.state).toBe("completed");
			expect(retained.stdout).toBe("ok");
			expect(String(retained.stderr)).toContain("warn");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("shell output lines starting with Full log stay in compact output", async () => {
		const tempRoot = await createTempDir("codelia-shell-tool-");
		const storageRoot = path.join(tempRoot, "storage");
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const storagePaths = resolveStoragePaths({ rootOverride: storageRoot });
			const shellTool = createShellTool(createSandboxKey(sandbox), {
				taskManager: new TaskManager({
					registry: new TaskRegistryStore(path.join(storageRoot, "tasks")),
				}),
				outputCacheStore: new ToolOutputCacheStoreImpl({ paths: storagePaths }),
			});

			const result = await shellTool.executeRaw(
				JSON.stringify({
					command: `node -e "process.stdout.write('Full log: keep-this\\nnext-line')"`,
				}),
				createToolContext(),
			);
			const value = expectJsonResult(result);
			expect(value.stdout).toBe("Full log: keep-this\nnext-line");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("shell allows duplicate labels and returns distinct keys", async () => {
		const tempRoot = await createTempDir("codelia-shell-tool-");
		const storageRoot = path.join(tempRoot, "storage");
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const storagePaths = resolveStoragePaths({ rootOverride: storageRoot });
			const taskManager = new TaskManager({
				registry: new TaskRegistryStore(path.join(storageRoot, "tasks")),
			});
			const shellTool = createShellTool(createSandboxKey(sandbox), {
				taskManager,
				outputCacheStore: new ToolOutputCacheStoreImpl({ paths: storagePaths }),
			});
			const shellCancelTool = createShellCancelTool({
				taskManager,
				outputCacheStore: new ToolOutputCacheStoreImpl({ paths: storagePaths }),
			});
			const shellStatusTool = createShellStatusTool({
				taskManager,
				outputCacheStore: new ToolOutputCacheStoreImpl({ paths: storagePaths }),
			});

			const first = expectJsonResult(
				await shellTool.executeRaw(
					JSON.stringify({
						command: `node -e "setTimeout(() => {}, 1000)"`,
						label: "dup",
						detached_wait: true,
					}),
					createToolContext(),
				),
			);
			const second = expectJsonResult(
				await shellTool.executeRaw(
					JSON.stringify({
						command: `node -e "setTimeout(() => {}, 1000)"`,
						label: "dup",
						detached_wait: true,
					}),
					createToolContext(),
				),
			);

			const firstKey = expectStringField(first, "key");
			const secondKey = expectStringField(second, "key");
			expect(firstKey).toMatch(/^dup-/);
			expect(secondKey).toMatch(/^dup-/);
			expect(firstKey).not.toBe(secondKey);

			const status = expectJsonResult(
				await shellStatusTool.executeRaw(
					JSON.stringify({ key: firstKey }),
					createToolContext(),
				),
			);
			expect(status.key).toBe(firstKey);

			await shellCancelTool.executeRaw(
				JSON.stringify({ key: firstKey }),
				createToolContext(),
			);
			await shellCancelTool.executeRaw(
				JSON.stringify({ key: secondKey }),
				createToolContext(),
			);
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("shell tools return stable keys and shell_list defaults to active compact summaries", async () => {
		const tempRoot = await createTempDir("codelia-shell-tool-");
		const storageRoot = path.join(tempRoot, "storage");
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const storagePaths = resolveStoragePaths({ rootOverride: storageRoot });
			const taskManager = new TaskManager({
				registry: new TaskRegistryStore(path.join(storageRoot, "tasks")),
			});
			const shellTool = createShellTool(createSandboxKey(sandbox), {
				taskManager,
				outputCacheStore: new ToolOutputCacheStoreImpl({ paths: storagePaths }),
			});
			const shellListTool = createShellListTool({
				taskManager,
				outputCacheStore: new ToolOutputCacheStoreImpl({ paths: storagePaths }),
			});
			const shellStatusTool = createShellStatusTool({
				taskManager,
				outputCacheStore: new ToolOutputCacheStoreImpl({ paths: storagePaths }),
			});
			const shellWaitTool = createShellWaitTool({
				taskManager,
				outputCacheStore: new ToolOutputCacheStoreImpl({ paths: storagePaths }),
			});

			const active = expectJsonResult(
				await shellTool.executeRaw(
					JSON.stringify({
						command: `node -e "process.stdout.write('build-start\\n'); setTimeout(() => { process.stdout.write('build-done'); }, 600)"`,
						label: "build",
						detached_wait: true,
					}),
					createToolContext(),
				),
			);
			const activeKey = expectStringField(active, "key");
			expect(activeKey).toMatch(/^build-/);

			const completed = expectJsonResult(
				await shellTool.executeRaw(
					JSON.stringify({
						command: `node -e "process.stdout.write('done-now')"`,
						label: "done-task",
					}),
					createToolContext(),
				),
			);
			expect(completed.state).toBe("completed");
			expect(completed.stdout).toBe("done-now");
			expect(completed.stderr).toBeUndefined();

			const listedActive = expectJsonResult(
				await shellListTool.executeRaw("{}", createToolContext()),
			);
			const activeTasks = listedActive.tasks as Array<Record<string, unknown>>;
			expect(listedActive.state).toBeNull();
			expect(listedActive.include_terminal).toBe(false);
			expect(activeTasks.some((task) => task.label === "build")).toBe(true);
			expect(activeTasks.some((task) => task.label === "done-task")).toBe(
				false,
			);
			expect(activeTasks.every((task) => !("task_id" in task))).toBe(true);
			expect(activeTasks.every((task) => !("working_directory" in task))).toBe(
				true,
			);
			expect(activeTasks.every((task) => !("created_at" in task))).toBe(true);
			expect(activeTasks.every((task) => !("title" in task))).toBe(true);
			expect(
				activeTasks.some(
					(task) => task.key === activeKey && task.label === "build",
				),
			).toBe(true);

			const listedAll = expectJsonResult(
				await shellListTool.executeRaw(
					JSON.stringify({ include_terminal: true }),
					createToolContext(),
				),
			);
			const allTasks = listedAll.tasks as Array<Record<string, unknown>>;
			expect(listedAll.state).toBeNull();
			expect(listedAll.include_terminal).toBe(true);
			expect(allTasks.some((task) => task.label === "done-task")).toBe(true);

			const listedRunning = expectJsonResult(
				await shellListTool.executeRaw(
					JSON.stringify({ state: "running", include_terminal: false }),
					createToolContext(),
				),
			);
			const runningTasks = listedRunning.tasks as Array<
				Record<string, unknown>
			>;
			expect(listedRunning.state).toBe("running");
			expect(listedRunning.include_terminal).toBe(false);
			expect(runningTasks.some((task) => task.label === "build")).toBe(true);
			expect(runningTasks.some((task) => task.label === "done-task")).toBe(
				false,
			);

			const statusByKey = expectJsonResult(
				await shellStatusTool.executeRaw(
					JSON.stringify({ key: activeKey }),
					createToolContext(),
				),
			);
			expect(statusByKey.key).toBe(activeKey);
			expect(["queued", "running"]).toContain(String(statusByKey.state));

			const waited = expectJsonResult(
				await shellWaitTool.executeRaw(
					JSON.stringify({ key: activeKey }),
					createToolContext(),
				),
			);
			expect(waited.state).toBe("completed");
			expect(waited.stdout).toBe("build-start\nbuild-done");
			expect(waited.stderr).toBeUndefined();
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("shell keys stay distinct across repeated labels over time", async () => {
		const tempRoot = await createTempDir("codelia-shell-tool-");
		const storageRoot = path.join(tempRoot, "storage");
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const storagePaths = resolveStoragePaths({ rootOverride: storageRoot });
			const taskManager = new TaskManager({
				registry: new TaskRegistryStore(path.join(storageRoot, "tasks")),
			});
			const shellTool = createShellTool(createSandboxKey(sandbox), {
				taskManager,
				outputCacheStore: new ToolOutputCacheStoreImpl({ paths: storagePaths }),
			});
			const shellStatusTool = createShellStatusTool({
				taskManager,
				outputCacheStore: new ToolOutputCacheStoreImpl({ paths: storagePaths }),
			});
			const shellWaitTool = createShellWaitTool({
				taskManager,
				outputCacheStore: new ToolOutputCacheStoreImpl({ paths: storagePaths }),
			});

			const finished = expectJsonResult(
				await shellTool.executeRaw(
					JSON.stringify({
						command: `node -e "process.stdout.write('old-finished')"`,
						label: "shared",
					}),
					createToolContext(),
				),
			);
			expect(finished.state).toBe("completed");

			const running = expectJsonResult(
				await shellTool.executeRaw(
					JSON.stringify({
						command: `node -e "process.stdout.write('new-start\\n'); setTimeout(() => { process.stdout.write('new-finish'); }, 300)"`,
						label: "shared",
						detached_wait: true,
					}),
					createToolContext(),
				),
			);
			const finishedKey = expectStringField(finished, "key");
			const runningKey = expectStringField(running, "key");
			expect(runningKey).not.toBe(finishedKey);

			const status = expectJsonResult(
				await shellStatusTool.executeRaw(
					JSON.stringify({ key: runningKey }),
					createToolContext(),
				),
			);
			expect(status.key).toBe(runningKey);
			expect(["queued", "running"]).toContain(String(status.state));

			const waited = expectJsonResult(
				await shellWaitTool.executeRaw(
					JSON.stringify({ key: runningKey }),
					createToolContext(),
				),
			);
			expect(waited.key).toBe(runningKey);
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("shell_logs tails live output to a bounded recent window", async () => {
		const tempRoot = await createTempDir("codelia-shell-tool-");
		const storageRoot = path.join(tempRoot, "storage");
		let taskManager: TaskManager | null = null;
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const storagePaths = resolveStoragePaths({ rootOverride: storageRoot });
			taskManager = new TaskManager({
				registry: new TaskRegistryStore(path.join(storageRoot, "tasks")),
			});
			const shellTool = createShellTool(createSandboxKey(sandbox), {
				taskManager,
				outputCacheStore: new ToolOutputCacheStoreImpl({ paths: storagePaths }),
			});
			const shellLogsTool = createShellLogsTool({
				taskManager,
				outputCacheStore: new ToolOutputCacheStoreImpl({ paths: storagePaths }),
			});
			const shellCancelTool = createShellCancelTool({
				taskManager,
				outputCacheStore: new ToolOutputCacheStoreImpl({ paths: storagePaths }),
			});

			const start = expectJsonResult(
				await shellTool.executeRaw(
					JSON.stringify({
						command: `node -e "process.stdout.write('BEGIN\\n' + 'x'.repeat(120000) + '\\nEND'); setTimeout(() => {}, 5000)"`,
						detached_wait: true,
					}),
					createToolContext(),
				),
			);
			const taskKey = expectStringField(start, "key");
			const liveLogs = await waitForLiveValue({
				read: async () =>
					expectJsonResult(
						await shellLogsTool.executeRaw(
							JSON.stringify({ key: String(taskKey), stream: "stdout" }),
							createToolContext(),
						),
					),
				isReady: (value) =>
					value.live === true && String(value.content).includes("END"),
				description: "bounded live stdout tail",
			});
			expect(liveLogs.live).toBe(true);
			expect(liveLogs.truncated).toBe(true);
			expect(String(liveLogs.content)).toContain("END");
			expect(String(liveLogs.content)).not.toContain("BEGIN");
			expect(Number(liveLogs.omitted_bytes ?? 0)).toBeGreaterThan(0);
			expect(Number(liveLogs.total_bytes ?? 0)).toBeGreaterThan(
				Number(liveLogs.tail_bytes ?? 0),
			);

			await shellCancelTool.executeRaw(
				JSON.stringify({ key: String(taskKey) }),
				createToolContext(),
			);
		} finally {
			await taskManager?.shutdown();
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("shell_logs tail_lines returns only the last live lines", async () => {
		const tempRoot = await createTempDir("codelia-shell-tool-");
		const storageRoot = path.join(tempRoot, "storage");
		let taskManager: TaskManager | null = null;
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const storagePaths = resolveStoragePaths({ rootOverride: storageRoot });
			taskManager = new TaskManager({
				registry: new TaskRegistryStore(path.join(storageRoot, "tasks")),
			});
			const shellTool = createShellTool(createSandboxKey(sandbox), {
				taskManager,
				outputCacheStore: new ToolOutputCacheStoreImpl({ paths: storagePaths }),
			});
			const shellLogsTool = createShellLogsTool({
				taskManager,
				outputCacheStore: new ToolOutputCacheStoreImpl({ paths: storagePaths }),
			});
			const shellCancelTool = createShellCancelTool({
				taskManager,
				outputCacheStore: new ToolOutputCacheStoreImpl({ paths: storagePaths }),
			});

			const start = expectJsonResult(
				await shellTool.executeRaw(
					JSON.stringify({
						command: `node -e "process.stdout.write(['line-1','line-2','line-3','line-4'].join('\\n')); setTimeout(() => {}, 5000)"`,
						label: "tail-live",
						detached_wait: true,
					}),
					createToolContext(),
				),
			);
			const taskKey = expectStringField(start, "key");
			const logs = await waitForLiveValue({
				read: async () =>
					expectJsonResult(
						await shellLogsTool.executeRaw(
							JSON.stringify({ key: String(taskKey), tail_lines: 2 }),
							createToolContext(),
						),
					),
				isReady: (value) => String(value.content).includes("line-4"),
				description: "last two live stdout lines",
			});
			expect(logs.live).toBe(true);
			expect(logs.label).toBe("tail-live");
			expect(logs.tail_lines).toBe(2);
			expect(String(logs.content)).toBe("line-3\nline-4");
			expect(logs.omitted_lines).toBe(2);

			await shellCancelTool.executeRaw(
				JSON.stringify({ key: String(taskKey) }),
				createToolContext(),
			);
		} finally {
			await taskManager?.shutdown();
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("shell_logs tail_lines ignores trailing empty line from final newline", async () => {
		const tempRoot = await createTempDir("codelia-shell-tool-");
		const storageRoot = path.join(tempRoot, "storage");
		let taskManager: TaskManager | null = null;
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const storagePaths = resolveStoragePaths({ rootOverride: storageRoot });
			taskManager = new TaskManager({
				registry: new TaskRegistryStore(path.join(storageRoot, "tasks")),
			});
			const shellTool = createShellTool(createSandboxKey(sandbox), {
				taskManager,
				outputCacheStore: new ToolOutputCacheStoreImpl({ paths: storagePaths }),
			});
			const shellLogsTool = createShellLogsTool({
				taskManager,
				outputCacheStore: new ToolOutputCacheStoreImpl({ paths: storagePaths }),
			});
			const shellCancelTool = createShellCancelTool({
				taskManager,
				outputCacheStore: new ToolOutputCacheStoreImpl({ paths: storagePaths }),
			});

			const start = expectJsonResult(
				await shellTool.executeRaw(
					JSON.stringify({
						command: `node -e "process.stdout.write('line-1\\nline-2\\n'); setTimeout(() => {}, 5000)"`,
						label: "tail-newline",
						detached_wait: true,
					}),
					createToolContext(),
				),
			);
			const taskKey = expectStringField(start, "key");
			const logs = await waitForLiveValue({
				read: async () =>
					expectJsonResult(
						await shellLogsTool.executeRaw(
							JSON.stringify({ key: String(taskKey), tail_lines: 1 }),
							createToolContext(),
						),
					),
				isReady: (value) => String(value.content) === "line-2",
				description: "last live stdout line without trailing empty line",
			});
			expect(logs.live).toBe(true);
			expect(logs.tail_lines).toBe(1);
			expect(String(logs.content)).toBe("line-2");
			expect(logs.omitted_lines).toBe(1);

			await shellCancelTool.executeRaw(
				JSON.stringify({ key: String(taskKey) }),
				createToolContext(),
			);
		} finally {
			await taskManager?.shutdown();
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("shell_logs reads retained cache-backed output after completion", async () => {
		const tempRoot = await createTempDir("codelia-shell-tool-");
		const storageRoot = path.join(tempRoot, "storage");
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const storagePaths = resolveStoragePaths({ rootOverride: storageRoot });
			const taskManager = new TaskManager({
				registry: new TaskRegistryStore(path.join(storageRoot, "tasks")),
			});
			const shellTool = createShellTool(createSandboxKey(sandbox), {
				taskManager,
				outputCacheStore: new ToolOutputCacheStoreImpl({ paths: storagePaths }),
			});
			const shellLogsTool = createShellLogsTool({
				taskManager,
				outputCacheStore: new ToolOutputCacheStoreImpl({ paths: storagePaths }),
			});

			const run = expectJsonResult(
				await shellTool.executeRaw(
					JSON.stringify({
						command: `node -e "process.stdout.write(Array.from({ length: 12000 }, (_, i) => 'line-' + i).join('\\n'))"`,
						label: "cache-tail",
					}),
					createToolContext(),
				),
			);
			const taskKey = expectStringField(run, "key");
			const cacheId = expectStringField(run, "stdout_cache_id");
			expect(cacheId).toBeDefined();

			const logs = expectJsonResult(
				await shellLogsTool.executeRaw(
					JSON.stringify({ key: String(taskKey), stream: "stdout" }),
					createToolContext(),
				),
			);
			expect(logs.live).toBe(false);
			expect(logs.cache_id).toBe(cacheId);
			expect(String(logs.content)).toContain("line-0");

			const tailedLogs = expectJsonResult(
				await shellLogsTool.executeRaw(
					JSON.stringify({
						key: String(taskKey),
						stream: "stdout",
						tail_lines: 3,
					}),
					createToolContext(),
				),
			);
			expect(tailedLogs.live).toBe(false);
			expect(tailedLogs.cache_id).toBe(cacheId);
			expect(tailedLogs.tail_lines).toBe(3);
			expect(String(tailedLogs.content)).toBe(
				"line-11997\nline-11998\nline-11999",
			);
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("shell_cancel stops a detached-wait shell task and returns compact cancellation JSON", async () => {
		const tempRoot = await createTempDir("codelia-shell-tool-");
		const storageRoot = path.join(tempRoot, "storage");
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const storagePaths = resolveStoragePaths({ rootOverride: storageRoot });
			const taskManager = new TaskManager({
				registry: new TaskRegistryStore(path.join(storageRoot, "tasks")),
			});
			const shellTool = createShellTool(createSandboxKey(sandbox), {
				taskManager,
				outputCacheStore: new ToolOutputCacheStoreImpl({ paths: storagePaths }),
			});
			const shellCancelTool = createShellCancelTool({
				taskManager,
				outputCacheStore: new ToolOutputCacheStoreImpl({ paths: storagePaths }),
			});

			const start = expectJsonResult(
				await shellTool.executeRaw(
					JSON.stringify({
						command: `node -e "setInterval(() => process.stdout.write('tick\\n'), 50)"`,
						detached_wait: true,
					}),
					createToolContext(),
				),
			);
			const taskKey = expectStringField(start, "key");
			const cancelled = expectJsonResult(
				await shellCancelTool.executeRaw(
					JSON.stringify({ key: String(taskKey) }),
					createToolContext(),
				),
			);
			expect(cancelled.key).toBe(taskKey);
			expect(cancelled.state).toBe("cancelled");
			expect(cancelled.cancellation_reason).toBe("cancelled");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});
});
