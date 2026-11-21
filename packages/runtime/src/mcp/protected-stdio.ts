import { authorizeRuntimeShell } from "../permissions/runtime-approval";
import { RuntimeState } from "../runtime-state";
import { resolveRuntimeSandboxMode } from "../sandbox/mode";
import { StdioMcpClient } from "./stdio-client";

type StdioConfig = {
	command?: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
};

export function spawnRuntimeMcpStdio(
	state: RuntimeState,
	workingDir: string,
	config: StdioConfig,
	trustedService: boolean,
	signal?: AbortSignal,
) {
	return authorizeRuntimeShell(state)(
		{
			argv: [config.command ?? "", ...(config.args ?? [])],
			cwd: config.cwd ?? workingDir,
			origin: "mcp_service",
			trustedService,
			mcpServiceEnvironment: config.env,
			stdin: "pipe",
			signal,
		},
		(admission) => admission(),
	);
}

/** An explicit CLI probe grants only this configured service launch. */
export async function createLocalMcpStdioProbeClient(
	serverId: string,
	config: StdioConfig,
) {
	const state = new RuntimeState();
	const environment = state.effectiveEnvironment;
	const workingDir = environment.workspace.root ?? process.cwd();
	state.runtimeWorkingDir = workingDir;
	state.runtimeSandboxRoot = workingDir;
	state.sandboxMode = await resolveRuntimeSandboxMode(environment);
	const child = await spawnRuntimeMcpStdio(state, workingDir, config, true);
	return new StdioMcpClient(
		{
			serverId,
			command: config.command ?? "",
			args: config.args ?? [],
			log: () => {},
		},
		child,
	);
}
