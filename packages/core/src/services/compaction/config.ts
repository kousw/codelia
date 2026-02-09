export type CompactionConfig = {
	enabled?: boolean; // default: true
	auto?: boolean; // default: true
	thresholdRatio?: number; // default: 0.8
	model?: string | null;
	summaryPrompt?: string;
	summaryDirectives?: string[];
	retainPrompt?: string | null;
	retainDirectives?: string[];
	retainLastTurns?: number; // default: 1
};
