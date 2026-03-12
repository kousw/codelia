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
				]),
			);
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
		expect(definition.description).toContain("By default wait for completion");
		expect(definition.description).toContain("detached_wait=true");
		expect(definition.description).toContain("runtime-managed child process");
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
		expect(String(timeoutDescription)).toContain(
			"Foreground default: 120, max 300",
		);
		expect(String(timeoutDescription)).toContain(
			"Detached-wait mode accepts larger values up to",
		);
		expect(String(timeoutDescription)).toContain(
			String(MAX_EXECUTION_TIMEOUT_SECONDS),
		);
		expect(String(timeoutDescription)).toContain("omit");
		const detachedWaitDescription = properties.detached_wait?.description;
		expect(typeof detachedWaitDescription).toBe("string");
		expect(String(detachedWaitDescription)).toContain("Skip the attached wait");
		expect(String(detachedWaitDescription)).toContain(
			"runtime still owns the child process",
		);
		expect(String(detachedWaitDescription)).toContain("finite jobs");
		expect(String(detachedWaitDescription)).toContain(
			"OS/shell-native out-of-process method",
		);
		expect(String(detachedWaitDescription)).toContain("nohup");
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
			expect(value.output).toBe("hello-shell");
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
			expect(value.output).toBe("ok");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("shell_status and shell_wait inspect a detached-wait shell task", async () => {
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
			expect(status.output).toBeUndefined();
			expect(status.error_output).toBeUndefined();

			let liveLogs: Record<string, unknown> | null = null;
			for (let attempt = 0; attempt < 10; attempt += 1) {
				liveLogs = expectJsonResult(
					await shellLogsTool.executeRaw(
						JSON.stringify({ key: taskKey, stream: "stdout" }),
						createToolContext(),
					),
				);
				if (String(liveLogs.content).includes("start")) {
					break;
				}
				await Bun.sleep(25);
			}
			expect(liveLogs?.live).toBe(true);
			expect(String(liveLogs?.content)).toContain("start");

			const waited = expectJsonResult(
				await shellWaitTool.executeRaw(
					JSON.stringify({ key: taskKey }),
					createToolContext(),
				),
			);
			expect(waited.key).toBe(taskKey);
			expect(waited.state).toBe("completed");
			expect(waited.exit_code).toBe(0);
			expect(waited.output).toBe("start\nfinish");

			const retained = expectJsonResult(
				await shellResultTool.executeRaw(
					JSON.stringify({ key: taskKey }),
					createToolContext(),
				),
			);
			expect(retained.key).toBe(taskKey);
			expect(retained.state).toBe("completed");
			expect(retained.output).toBe("start\nfinish");
		} finally {
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
			expect(firstWait.output).toBeUndefined();

			const secondWait = expectJsonResult(
				await shellWaitTool.executeRaw(
					JSON.stringify({ key: taskKey, wait_timeout: 3 }),
					createToolContext(),
				),
			);
			expect(secondWait.key).toBe(taskKey);
			expect(secondWait.state).toBe("completed");
			expect(secondWait.exit_code).toBe(0);
			expect(secondWait.output).toBe("done");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("shell_wait and shell_result preserve failed state in compact terminal JSON", async () => {
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
						command: `node -e "process.stderr.write('boom'); process.exit(7)"`,
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
			expect(String(waited.error_output)).toContain("boom");

			const retained = expectJsonResult(
				await shellResultTool.executeRaw(
					JSON.stringify({ key: taskKey }),
					createToolContext(),
				),
			);
			expect(retained.key).toBe(taskKey);
			expect(retained.state).toBe("failed");
			expect(retained.exit_code).toBe(7);
			expect(String(retained.error_output)).toContain("boom");
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
			expect(value.output).toBe("Full log: keep-this\nnext-line");
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
			expect(completed.output).toBe("done-now");

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
			expect(waited.output).toBe("build-start\nbuild-done");
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
			const shellCancelTool = createShellCancelTool({
				taskManager,
				outputCacheStore: new ToolOutputCacheStoreImpl({ paths: storagePaths }),
			});

			const start = expectJsonResult(
				await shellTool.executeRaw(
					JSON.stringify({
						command: `node -e "process.stdout.write('BEGIN\\n' + 'x'.repeat(120000) + '\\nEND'); setTimeout(() => {}, 1000)"`,
						detached_wait: true,
					}),
					createToolContext(),
				),
			);
			const taskKey = expectStringField(start, "key");
			let liveLogs: Record<string, unknown> | null = null;
			for (let attempt = 0; attempt < 20; attempt += 1) {
				liveLogs = expectJsonResult(
					await shellLogsTool.executeRaw(
						JSON.stringify({ key: String(taskKey), stream: "stdout" }),
						createToolContext(),
					),
				);
				if (
					liveLogs.live === true &&
					String(liveLogs.content).includes("END")
				) {
					break;
				}
				await Bun.sleep(25);
			}
			expect(liveLogs?.live).toBe(true);
			expect(liveLogs?.truncated).toBe(true);
			expect(String(liveLogs?.content)).toContain("END");
			expect(String(liveLogs?.content)).not.toContain("BEGIN");
			expect(Number(liveLogs?.omitted_bytes ?? 0)).toBeGreaterThan(0);
			expect(Number(liveLogs?.total_bytes ?? 0)).toBeGreaterThan(
				Number(liveLogs?.tail_bytes ?? 0),
			);

			await shellCancelTool.executeRaw(
				JSON.stringify({ key: String(taskKey) }),
				createToolContext(),
			);
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("shell_logs tail_lines returns only the last live lines", async () => {
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
			const shellCancelTool = createShellCancelTool({
				taskManager,
				outputCacheStore: new ToolOutputCacheStoreImpl({ paths: storagePaths }),
			});

			const start = expectJsonResult(
				await shellTool.executeRaw(
					JSON.stringify({
						command: `node -e "process.stdout.write(['line-1','line-2','line-3','line-4'].join('\\n')); setTimeout(() => {}, 1000)"`,
						label: "tail-live",
						detached_wait: true,
					}),
					createToolContext(),
				),
			);
			const taskKey = expectStringField(start, "key");
			let logs: Record<string, unknown> | null = null;
			for (let attempt = 0; attempt < 20; attempt += 1) {
				logs = expectJsonResult(
					await shellLogsTool.executeRaw(
						JSON.stringify({ key: String(taskKey), tail_lines: 2 }),
						createToolContext(),
					),
				);
				if (String(logs.content).includes("line-4")) {
					break;
				}
				await Bun.sleep(25);
			}
			expect(logs?.live).toBe(true);
			expect(logs?.label).toBe("tail-live");
			expect(logs?.tail_lines).toBe(2);
			expect(String(logs?.content)).toBe("line-3\nline-4");
			expect(logs?.omitted_lines).toBe(2);

			await shellCancelTool.executeRaw(
				JSON.stringify({ key: String(taskKey) }),
				createToolContext(),
			);
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("shell_logs tail_lines ignores trailing empty line from final newline", async () => {
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
			const shellCancelTool = createShellCancelTool({
				taskManager,
				outputCacheStore: new ToolOutputCacheStoreImpl({ paths: storagePaths }),
			});

			const start = expectJsonResult(
				await shellTool.executeRaw(
					JSON.stringify({
						command: `node -e "process.stdout.write('line-1\\nline-2\\n'); setTimeout(() => {}, 1000)"`,
						label: "tail-newline",
						detached_wait: true,
					}),
					createToolContext(),
				),
			);
			const taskKey = expectStringField(start, "key");
			let logs: Record<string, unknown> | null = null;
			for (let attempt = 0; attempt < 20; attempt += 1) {
				logs = expectJsonResult(
					await shellLogsTool.executeRaw(
						JSON.stringify({ key: String(taskKey), tail_lines: 1 }),
						createToolContext(),
					),
				);
				if (String(logs.content) === "line-2") {
					break;
				}
				await Bun.sleep(25);
			}
			expect(logs?.live).toBe(true);
			expect(logs?.tail_lines).toBe(1);
			expect(String(logs?.content)).toBe("line-2");
			expect(logs?.omitted_lines).toBe(1);

			await shellCancelTool.executeRaw(
				JSON.stringify({ key: String(taskKey) }),
				createToolContext(),
			);
		} finally {
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
			const cacheId = expectStringField(run, "cache_id");
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
