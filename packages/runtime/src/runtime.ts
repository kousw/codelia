import path from "node:path";
import type { RpcMessage } from "@codelia/protocol";
import { SessionStateStoreImpl } from "@codelia/storage";
import {
	createAgentFactory,
	requestMcpOAuthTokensWithRunStatus,
} from "./agent-factory";
import { log } from "./logger";
import { McpManager } from "./mcp";
import { createRuntimeHandlers } from "./rpc/handlers";
import { RuntimeState } from "./runtime-state";

export const startRuntime = (): void => {
	void (async () => {
		const state = new RuntimeState();
		const workingDir = process.env.CODELIA_SANDBOX_ROOT
			? path.resolve(process.env.CODELIA_SANDBOX_ROOT)
			: process.cwd();
		state.runtimeWorkingDir = workingDir;
		state.runtimeSandboxRoot = workingDir;
		const sessionStateStore = new SessionStateStoreImpl({
			onError: (error, context) => {
				log(
					`Error: session-state ${context.action} error${context.detail ? ` (${context.detail})` : ""}: ${String(error)}`,
				);
			},
		});
		try {
			await sessionStateStore.list();
		} catch (error) {
			log(`Error: session index database is not available: ${String(error)}`);
			process.exit(1);
			return;
		}

		const mcpManager = new McpManager({ workingDir, log });
		void mcpManager.start({
			onStatus: (message) => log(`mcp: ${message}`),
			requestOAuthTokens: ({ server_id, oauth, error }) =>
				requestMcpOAuthTokensWithRunStatus(state, server_id, oauth, error),
		});
		const getAgent = createAgentFactory(state, { mcpManager });
		const { processMessage } = createRuntimeHandlers({
			state,
			getAgent,
			log,
			mcpManager,
			sessionStateStore,
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
	})();
};
