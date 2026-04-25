export type ReasoningLevel = "low" | "medium" | "high" | "xhigh";

export const REASONING_LEVELS: ReasoningLevel[] = [
	"low",
	"medium",
	"high",
	"xhigh",
];

export type ComposerModelState = {
	current?: string;
	provider?: string;
	models: string[];
	reasoning?: string;
	fast?: boolean;
};

export type ComposerGitState = {
	branch?: string | null;
	branches: string[];
	isDirty?: boolean;
};
