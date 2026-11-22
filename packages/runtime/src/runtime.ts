import {
	cleanupRunLogs,
	isTrustedGlobalConfigLocationSync,
	RunEventStoreFactoryImpl,
	resolveStoragePaths,
	SessionStateStoreImpl,
} from "@codelia/storage";
import {
	createAgentFactory,
	requestMcpOAuthTokensWithRunStatus,
} from "./agent-factory";
import { AgentsResolver } from "./agents";
import { createRuntimeAttachmentService } from "./attachments/local";
import { resolveConfigPath } from "./config";
import { isProcessEnabled, type RuntimeOptions } from "./environment";
import { log } from "./logger";
import { McpManager } from "./mcp";
import { spawnRuntimeMcpStdio } from "./mcp/protected-stdio";
import { authorizeRuntimeShell } from "./permissions/runtime-approval";
import {
	runtimeResourcePolicy,
	runtimeResourceReader,
} from "./permissions/runtime-resource-policy";
import { createRuntimeHandlers } from "./rpc/handlers";
import { RuntimeState } from "./runtime-state";
import { resolveRuntimeSandboxMode } from "./sandbox/mode";
import { AgentTreeCoordinator } from "./subagents/coordinator";
import { createProcessSubagentFactory } from "./subagents/process-executor";
import { TaskManager } from "./tasks";
import {
	VolatileRunEventStoreFactory,
	VolatileSessionStateStore,
} from "./volatile-stores";

const envTruthy = (value?: string): boolean => {
	if (!value) return false;
	const normalized = value.trim().toLowerCase();
	return normalized === "1" || normalized === "true";
};

export const startRuntime = async (
	options: RuntimeOptions = {},
): Promise<void> => {
	const state = new RuntimeState();
	state.setRuntimeEnvironment(options);
	const environment = state.effectiveEnvironment;
	state.sandboxMode = await resolveRuntimeSandboxMode(environment);
	if (state.sandboxMode.legacy === "full-access")
		log(
			"Legacy approval_mode full-access uses workspace-write. Specify --sandbox-mode full-access to disable OS isolation and keep command approval.",
		);
	state.diagnosticsEnabled = envTruthy(process.env.CODELIA_DIAGNOSTICS);
	const workingDir = environment.workspace.root;
	if (workingDir) {
		state.runtimeWorkingDir = workingDir;
		state.runtimeSandboxRoot = workingDir;
		if (environment.sourcePreset === "tui-local")
			await runtimeResourcePolicy(state, workingDir);
	}
	state.attachments = createRuntimeAttachmentService(state);

	if (
		environment.context.projectInstructions === "from-workspace" &&
		workingDir
	) {
		try {
			state.agentsResolver = await AgentsResolver.create(
				workingDir,
				undefined,
				undefined,
				await runtimeResourceReader(state, workingDir),
			);
		} catch (error) {
			log(`agents resolver startup init failed: ${String(error)}`);
		}
	}

	const sessionStateStore =
		environment.adapters.stores?.sessionStateStore ??
		(environment.persistence.mode === "volatile"
			? new VolatileSessionStateStore()
			: new SessionStateStoreImpl({
					onError: (error, context) => {
						log(
							`Error: session-state ${context.action} error${context.detail ? ` (${context.detail})` : ""}: ${String(error)}`,
						);
					},
				}));
	if (environment.persistence.mode === "runtime") {
		try {
			await sessionStateStore.list();
		} catch (error) {
			throw new Error(
				`session index database is not available: ${String(error)}`,
			);
		}
	}
	const runEventStoreFactory =
		environment.adapters.stores?.runEventStoreFactory ??
		(environment.persistence.mode === "volatile"
			? new VolatileRunEventStoreFactory()
			: new RunEventStoreFactoryImpl({
					...(sessionStateStore instanceof SessionStateStoreImpl
						? { runIndex: sessionStateStore }
						: {}),
					onRunIndexError: (error) =>
						log(`session run index error: ${String(error)}`),
				}));

	if (
		environment.persistence.mode === "runtime" &&
		!environment.adapters.stores?.sessionStateStore &&
		!environment.adapters.stores?.runEventStoreFactory &&
		sessionStateStore instanceof SessionStateStoreImpl
	) {
		void cleanupRunLogs({
			paths: resolveStoragePaths(),
			sessions: sessionStateStore,
		})
			.then((result) => {
				if (result.compressed || result.deleted || result.failed)
					log(
						`session logs maintenance: compressed=${result.compressed} diagnostic_deleted=${result.deleted} failed=${result.failed} bytes=${result.reclaimed_bytes}`,
					);
			})
			.catch((error) => log(`session log cleanup failed: ${String(error)}`));
	}

	const taskManager = isProcessEnabled(environment)
		? (environment.adapters.stores?.taskManager ?? new TaskManager())
		: undefined;
	if (taskManager) {
		const recoveredTasks = await taskManager.recoverOrphanedTasks();
		if (recoveredTasks.recovered > 0 || recoveredTasks.errors.length > 0) {
			log(
				`tasks.recover recovered=${recoveredTasks.recovered} errors=${recoveredTasks.errors.length}`,
			);
			for (const error of recoveredTasks.errors) {
				log(`tasks.recover error task_id=${error.task_id}: ${error.error}`);
			}
		}
	}

	let resolveClientInitialized: (initialized: boolean) => void;
	const clientInitialized = new Promise<boolean>((resolve) => {
		resolveClientInitialized = resolve;
	});
	const mcpManager =
		environment.tools.mcp === "from-config" && workingDir
			? new McpManager({
					workingDir,
					log,
					spawnStdio: async (config, signal) => {
						const trustedGlobal =
							config.source === "global" &&
							(environment.config.source !== "runtime-default" ||
								isTrustedGlobalConfigLocationSync(
									workingDir,
									resolveConfigPath(),
								));
						if (
							!trustedGlobal &&
							!environment.adapters.approvalService &&
							!(await clientInitialized)
						)
							throw new Error("MCP startup ended before client initialization");
						signal?.throwIfAborted();
						return spawnRuntimeMcpStdio(
							state,
							workingDir,
							config,
							trustedGlobal,
							signal,
						);
					},
				})
			: undefined;
	let shutdownPromise: Promise<void> | null = null;
	const shutdownResources = async (reason: string): Promise<void> => {
		resolveClientInitialized(false);
		if (shutdownPromise) {
			await shutdownPromise;
			return;
		}
		shutdownPromise = (async () => {
			const results = await Promise.allSettled([
				(async () => {
					if (!taskManager) return;
					const result = await taskManager.shutdown();
					if (result.cancelled > 0 || result.errors.length > 0) {
						log(
							`tasks.shutdown reason=${reason} cancelled=${result.cancelled} errors=${result.errors.length}`,
						);
						for (const error of result.errors) {
							log(
								`tasks.shutdown error task_id=${error.task_id}: ${error.error}`,
							);
						}
					}
				})(),
				mcpManager?.close(),
				state.attachments?.close(),
			]);
			const names = ["tasks", "mcp", "attachments"];
			for (const [index, result] of results.entries()) {
				if (result.status === "rejected") {
					log(`${names[index]}.shutdown failed`);
				}
			}
		})();
		await shutdownPromise;
	};

	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.once(signal, () => {
			void shutdownResources(signal).finally(() => {
				process.kill(process.pid, signal);
			});
		});
	}
	process.once("beforeExit", () => {
		void shutdownResources("beforeExit");
	});
	process.stdin.once("end", () => {
		void shutdownResources("stdin.end");
	});

	if (mcpManager) {
		void mcpManager
			.start({
				onStatus: (message) => log(`mcp: ${message}`),
				requestOAuthTokens: ({ server_id, oauth, error, signal }) =>
					requestMcpOAuthTokensWithRunStatus(
						state,
						server_id,
						oauth,
						error,
						signal,
					),
			})
			.catch(() => log("mcp startup failed"));
	}
	const factory =
		environment.adapters.subagentExecutorFactory ??
		(environment.sourcePreset === "tui-local" &&
		!environment.adapters.stores?.taskManager
			? createProcessSubagentFactory()
			: undefined);
	const subagents =
		taskManager && workingDir && factory?.isAvailable()
			? new AgentTreeCoordinator(
					taskManager,
					factory,
					authorizeRuntimeShell(state),
				)
			: undefined;
	const getAgent = createAgentFactory(state, {
		sessionStateStore,
		mcpManager,
		taskManager,
		subagents,
	});
	const { processMessage } = createRuntimeHandlers({
		state,
		getAgent,
		subagents,
		log,
		mcpManager,
		onInitialized: () => resolveClientInitialized(true),
		sessionStateStore,
		runEventStoreFactory,
		taskManager,
		...(environment.persistence.mode === "runtime" &&
		!environment.adapters.stores?.sessionStateStore &&
		!environment.adapters.stores?.runEventStoreFactory &&
		sessionStateStore instanceof SessionStateStoreImpl
			? {
					cleanupSessionLogs: async (sessionId: string) => {
						await cleanupRunLogs({
							paths: resolveStoragePaths(),
							sessions: sessionStateStore,
							sessionId,
						});
					},
				}
			: {}),
	});

	log("runtime started");
	process.stdin.setEncoding("utf8");
	let buffer = "";
	process.stdin.on("data", (chunk) => {
		buffer += chunk;
		let index = buffer.indexOf("\n");
		while (index >= 0) {
			const line = buffer.slice(0, index).trim();
			buffer = buffer.slice(index + 1);
			if (line) {
				try {
					const msg: unknown = JSON.parse(line);
					processMessage(msg);
				} catch (error) {
					log(`invalid json: ${String(error)}`);
				}
			}
			index = buffer.indexOf("\n");
		}
	});
};
