import type {
	ContextInspectParams,
	ContextInspectResult,
} from "@codelia/protocol";
import { AgentsResolver } from "../agents";
import { resolveSkillsConfig } from "../config";
import type { RuntimeState } from "../runtime-state";
import { SkillsResolver } from "../skills";
import { sendError, sendResult } from "./transport";

export type ContextHandlersDeps = {
	state: RuntimeState;
	log: (message: string) => void;
};

export const createContextHandlers = ({
	state,
	log,
}: ContextHandlersDeps): {
	handleContextInspect: (
		id: string,
		params: ContextInspectParams,
	) => Promise<void>;
} => {
	const ensureAgentsResolver = async (): Promise<AgentsResolver | null> => {
		if (state.agentsResolver) {
			return state.agentsResolver;
		}
		const workingDir =
			state.runtimeWorkingDir ?? state.lastUiContext?.cwd ?? process.cwd();
		try {
			const resolver = await AgentsResolver.create(workingDir);
			state.agentsResolver = resolver;
			state.runtimeWorkingDir = workingDir;
			if (!state.runtimeSandboxRoot) {
				state.runtimeSandboxRoot = workingDir;
			}
			return resolver;
		} catch (error) {
			log(`context.inspect agents resolver error: ${String(error)}`);
			return null;
		}
	};

	const ensureSkillsResolver = async (): Promise<SkillsResolver | null> => {
		if (state.skillsResolver) {
			return state.skillsResolver;
		}
		const workingDir =
			state.runtimeWorkingDir ?? state.lastUiContext?.cwd ?? process.cwd();
		try {
			const resolver = await SkillsResolver.create({
				workingDir,
				config: await resolveSkillsConfig(workingDir),
			});
			state.skillsResolver = resolver;
			state.runtimeWorkingDir = workingDir;
			if (!state.runtimeSandboxRoot) {
				state.runtimeSandboxRoot = workingDir;
			}
			return resolver;
		} catch (error) {
			log(`context.inspect skills resolver error: ${String(error)}`);
			return null;
		}
	};

	const handleContextInspect = async (
		id: string,
		params: ContextInspectParams,
	): Promise<void> => {
		const includeAgents = params?.include_agents ?? true;
		const includeSkills = params?.include_skills ?? true;
		try {
			const result: ContextInspectResult = {
				runtime_working_dir: state.runtimeWorkingDir ?? undefined,
				runtime_sandbox_root: state.runtimeSandboxRoot ?? undefined,
				ui_context: {
					cwd: state.lastUiContext?.cwd,
					workspace_root: state.lastUiContext?.workspace_root,
					active_file_path: state.lastUiContext?.active_file?.path,
				},
			};
			if (includeAgents) {
				const resolver = await ensureAgentsResolver();
				if (resolver) {
					const snapshot = resolver.getSnapshot();
					result.agents = {
						enabled: snapshot.enabled,
						root_dir: snapshot.rootDir,
						working_dir: snapshot.workingDir,
						covered_dirs: snapshot.coveredDirs,
						initial_files: snapshot.initialFiles.map((file) => ({
							path: file.path,
							mtime_ms: Math.trunc(file.mtimeMs),
							size_bytes: file.sizeBytes,
						})),
						loaded_files: snapshot.loadedFiles.map((file) => ({
							path: file.path,
							mtime_ms: Math.trunc(file.mtimeMs),
							size_bytes: file.sizeBytes,
						})),
					};
				}
			}
			if (includeSkills) {
				const resolver = await ensureSkillsResolver();
				if (resolver) {
					const snapshot = resolver.getSnapshot();
					state.updateSkillsSnapshot(snapshot.working_dir, snapshot);
					result.skills = snapshot;
				}
			}
			sendResult(id, result);
		} catch (error) {
			sendError(id, {
				code: -32000,
				message: `context.inspect failed: ${String(error)}`,
			});
		}
	};

	return { handleContextInspect };
};
