import type { RpcMessage } from "@codelia/protocol";
import {
	RunEventStoreFactoryImpl,
	SessionStateStoreImpl,
} from "@codelia/storage";
import {
	createAgentFactory,
	requestMcpOAuthTokensWithRunStatus,
} from "./agent-factory";
import { AgentsResolver } from "./agents";
import { type RuntimeOptions, isProcessEnabled } from "./environment";
import { log } from "./logger";
import { McpManager } from "./mcp";
import { createRuntimeHandlers } from "./rpc/handlers";
import { RuntimeState } from "./runtime-state";
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
	state.diagnosticsEnabled = envTruthy(process.env.CODELIA_DIAGNOSTICS);
	const workingDir = environment.workspace.root;
	if (workingDir) {
		state.runtimeWorkingDir = workingDir;
		state.runtimeSandboxRoot = workingDir;
	}

	if (
		environment.context.projectInstructions === "from-workspace" &&
		workingDir
	) {
		try {
			state.agentsResolver = await AgentsResolver.create(workingDir);
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
			: new RunEventStoreFactoryImpl());

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

	let shutdownPromise: Promise<void> | null = null;
	const shutdownTasks = async (reason: string): Promise<void> => {
		if (!taskManager) return;
		if (shutdownPromise) {
			await shutdownPromise;
			return;
		}
		shutdownPromise = (async () => {
			const result = await taskManager.shutdown();
			if (result.cancelled > 0 || result.errors.length > 0) {
				log(
					`tasks.shutdown reason=${reason} cancelled=${result.cancelled} errors=${result.errors.length}`,
				);
				for (const error of result.errors) {
					log(`tasks.shutdown error task_id=${error.task_id}: ${error.error}`);
				}
			}
		})();
		await shutdownPromise;
	};

	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.once(signal, () => {
			void shutdownTasks(signal).finally(() => {
				process.kill(process.pid, signal);
			});
		});
	}
	process.once("beforeExit", () => {
		void shutdownTasks("beforeExit");
	});
	process.stdin.once("end", () => {
		void shutdownTasks("stdin.end");
	});

	const mcpManager =
		environment.tools.mcp === "from-config" && workingDir
			? new McpManager({ workingDir, log })
			: undefined;
	if (mcpManager) {
		void mcpManager.start({
			onStatus: (message) => log(`mcp: ${message}`),
			requestOAuthTokens: ({ server_id, oauth, error }) =>
				requestMcpOAuthTokensWithRunStatus(state, server_id, oauth, error),
		});
	}
	const getAgent = createAgentFactory(state, { mcpManager, taskManager });
	const { processMessage } = createRuntimeHandlers({
		state,
		getAgent,
		log,
		mcpManager,
		sessionStateStore,
		runEventStoreFactory,
		taskManager,
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
					const msg = JSON.parse(line) as RpcMessage;
					processMessage(msg);
				} catch (error) {
					log(`invalid json: ${String(error)}`);
				}
			}
			index = buffer.indexOf("\n");
		}
	});
};
