import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { DependencyKey, Tool, ToolOutputCacheStore } from "@codelia/core";
import { defineTool } from "@codelia/core";
import { z } from "zod";
import { debugLog } from "../logger";
import { getSandboxContext, type SandboxContext } from "../sandbox/context";
import { createUnifiedDiff, summarizeDiff } from "../utils/diff";

const buildDiffPayload = async (
	toolName: string,
	filePath: string,
	before: string,
	after: string,
	outputCacheStore?: ToolOutputCacheStore | null,
): Promise<{
	diff: string;
	diff_truncated?: boolean;
	diff_cache_id?: string;
	diff_cache_error?: string;
}> => {
	const fullDiff = createUnifiedDiff(filePath, before, after);
	if (!fullDiff) {
		return {
			diff: `--- ${filePath}\n+++ ${filePath}\n@@ -0,0 +0,0 @@`,
		};
	}
	const summarized = summarizeDiff(fullDiff);
	if (!summarized.truncated) {
		return { diff: summarized.preview };
	}
	if (!outputCacheStore) {
		return {
			diff: summarized.preview,
			diff_truncated: true,
		};
	}
	try {
		const saved = await outputCacheStore.save({
			tool_call_id: `${toolName}_diff_${crypto.randomUUID()}`,
			tool_name: toolName,
			content: fullDiff,
		});
		return {
			diff: summarized.preview,
			diff_truncated: true,
			diff_cache_id: saved.id,
		};
	} catch (error) {
		const message = `Failed to persist full diff: ${String(error)}`;
		debugLog(
			`write.diff_cache_save_failed tool=${toolName} file=${filePath} error=${String(error)}`,
		);
		return {
			diff: summarized.preview,
			diff_truncated: true,
			diff_cache_error: message,
		};
	}
};

export const createWriteTool = (
	sandboxKey: DependencyKey<SandboxContext>,
	outputCacheStore?: ToolOutputCacheStore | null,
): Tool =>
	defineTool({
		name: "write",
		description: "Write text to a file, creating parent directories if needed.",
		input: z.object({
			file_path: z
				.string()
				.describe(
					"File path. Sandbox-bounded unless full-access mode is active.",
				),
			content: z.string().describe("UTF-8 text content to write."),
		}),
		execute: async (input, ctx) => {
			let resolved: string;
			try {
				const sandbox = await getSandboxContext(ctx, sandboxKey);
				resolved = sandbox.resolvePath(input.file_path);
			} catch (error) {
				throw new Error(`Security error: ${String(error)}`);
			}

			try {
				let before = "";
				try {
					before = await fs.readFile(resolved, "utf8");
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
						throw error;
					}
				}
				await fs.mkdir(path.dirname(resolved), { recursive: true });
				await fs.writeFile(resolved, input.content, "utf8");
				const diffPayload = await buildDiffPayload(
					"write",
					input.file_path,
					before,
					input.content,
					outputCacheStore,
				);
				return {
					summary: `Wrote ${Buffer.byteLength(input.content, "utf8")} bytes to ${input.file_path}`,
					...diffPayload,
					file_path: input.file_path,
				};
			} catch (error) {
				return `Error writing file: ${String(error)}`;
			}
		},
	});
