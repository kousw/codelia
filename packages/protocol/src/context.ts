import type { SkillCatalog } from "@codelia/shared-types";

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
	ui_context?: {
		cwd?: string;
		workspace_root?: string;
		active_file_path?: string;
	};
	agents?: ContextInspectAgents;
	skills?: ContextInspectSkills;
};
