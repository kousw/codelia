import type { SkillLoadError, SkillMetadata } from "@codelia/shared-types";

export type SkillsListParams = {
	cwd?: string;
	force_reload?: boolean;
};

export type SkillsListResult = {
	skills: SkillMetadata[];
	errors: SkillLoadError[];
	truncated: boolean;
};
