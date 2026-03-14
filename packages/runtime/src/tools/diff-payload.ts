import crypto from "node:crypto";
import type { ToolOutputCacheStore } from "@codelia/core";
import { debugLog } from "../logger";
import { summarizeDiff } from "../utils/diff";

export const buildDiffPayload = async (options: {
	toolName: string;
	diff: string;
	outputCacheStore?: ToolOutputCacheStore | null;
	emptyDiff?: string;
	debugContext?: string;
}): Promise<{
	diff: string;
	diff_truncated?: boolean;
	diff_cache_id?: string;
	diff_cache_error?: string;
}> => {
	if (!options.diff) {
		return {
			diff: options.emptyDiff ?? "",
		};
	}

	const summarized = summarizeDiff(options.diff);
	if (!summarized.truncated) {
		return { diff: summarized.preview };
	}
	if (!options.outputCacheStore) {
		return {
			diff: summarized.preview,
			diff_truncated: true,
		};
	}
	try {
		const saved = await options.outputCacheStore.save({
			tool_call_id: `${options.toolName}_diff_${crypto.randomUUID()}`,
			tool_name: options.toolName,
			content: options.diff,
		});
		return {
			diff: summarized.preview,
			diff_truncated: true,
			diff_cache_id: saved.id,
		};
	} catch (error) {
		const message = `Failed to persist full diff: ${String(error)}`;
		const context = options.debugContext ? ` ${options.debugContext}` : "";
		debugLog(
			`${options.toolName}.diff_cache_save_failed${context} error=${String(error)}`,
		);
		return {
			diff: summarized.preview,
			diff_truncated: true,
			diff_cache_error: message,
		};
	}
};
