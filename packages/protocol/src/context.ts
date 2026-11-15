import type { ContextUsage, SkillCatalog } from "@codelia/shared-types";

export type ContextInspectParams = {
	include_agents?: boolean;
	include_skills?: boolean;
};

export type ContextInspectFile = {
	path: string;
	mtime_ms: number;
	size_bytes: number;
};

export type ContextInspectAgents = {
	enabled: boolean;
	root_dir: string;
	working_dir: string;
	covered_dirs: string[];
	initial_files: ContextInspectFile[];
	loaded_files: ContextInspectFile[];
};

export type ContextInspectSkillsLoadedVersion = {
	path: string;
	mtime_ms: number;
};

export type ContextInspectSkills = {
	root_dir: string;
	working_dir: string;
	catalog: SkillCatalog;
	loaded_versions: ContextInspectSkillsLoadedVersion[];
};

export type ContextInspectResult = {
	runtime_working_dir?: string;
	runtime_sandbox_root?: string;
	execution_environment?: string;
	ui_context?: {
		cwd?: string;
		workspace_root?: string;
		active_file_path?: string;
	};
	runtime_environment?: Record<string, unknown>;
	agents?: ContextInspectAgents;
	skills?: ContextInspectSkills;
};

export type ContextUsageParams = Record<string, never>;

/**
 * `context.usage` result. Without a built agent: `basis: "none"`, null counts
 * and an empty breakdown (the request never builds an agent or prompts).
 */
export type ContextUsageResult = ContextUsage & { session_id?: string };

/** Opt-in (`supports_context_usage`) notification after each model call. */
export type RunContextUsageNotify = ContextUsage & { run_id: string };
