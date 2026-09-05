import { defineTool, type Tool, type ToolResult } from "@codelia/core";
import { z } from "zod";
import type { SubagentChannel } from "./contracts";
import { createWorkspaceFiles } from "./workspace-files";

export const createSubagentWriteTools = (
	root: string,
	channel?: SubagentChannel,
): Tool[] => {
	const files = createWorkspaceFiles(root);
	const hash = z
		.string()
		.regex(/^[a-f0-9]{64}$/)
		.describe(
			"Required full content_sha256 from the latest read/read_line. A mismatch requires rereading and coordination.",
		);
	return [
		defineTool({
			name: "write",
			description:
				"Write a UTF-8 file in the shared workspace. Coordinate file ownership first. Existing files require the latest content_sha256; use missing only to create a new file without overwriting. Shell writes have no hash guard.",
			input: z.object({
				file_path: z.string(),
				content: z.string().max(100000),
				expected_hash: z.union([hash, z.literal("missing")]),
			}),
			execute: async (
				input,
				ctx,
			): Promise<
				ToolResult | { file_path: string; content_sha256: string }
			> => {
				ctx.signal?.throwIfAborted();
				if (channel)
					return {
						type: "json" as const,
						value: await channel.request("write", input, ctx.signal),
					};
				return {
					file_path: input.file_path,
					content_sha256: await files.update(
						input.file_path,
						input.expected_hash,
						() => input.content,
						ctx.signal,
					),
				};
			},
		}),
		defineTool({
			name: "edit",
			description:
				"Replace one exact unique text occurrence in a shared workspace file. Requires the latest full content hash. If changed or ambiguous, reread and message collaborators; never overwrite their changes blindly.",
			input: z.object({
				file_path: z.string(),
				old_string: z.string().min(1).max(50000),
				new_string: z.string().max(50000),
				expected_hash: hash,
			}),
			execute: async (
				input,
				ctx,
			): Promise<
				ToolResult | { file_path: string; content_sha256: string }
			> => {
				ctx.signal?.throwIfAborted();
				if (channel)
					return {
						type: "json" as const,
						value: await channel.request("edit", input, ctx.signal),
					};
				return {
					file_path: input.file_path,
					content_sha256: await files.update(
						input.file_path,
						input.expected_hash,
						(before) => {
							const index = before.indexOf(input.old_string);
							if (index < 0 || before.indexOf(input.old_string, index + 1) >= 0)
								throw new Error("Expected one exact match; reread the file");
							return (
								before.slice(0, index) +
								input.new_string +
								before.slice(index + input.old_string.length)
							);
						},
						ctx.signal,
					),
				};
			},
		}),
		defineTool({
			name: "shell",
			description:
				"Run a bounded command such as tests/builds in the shared workspace through the owning parent runtime and its approval policy. Commands can change files and are not protected by edit hashes. Coordinate before running commands that affect others; do not launch persistent services.",
			input: z.object({
				command: z.string().min(1).max(32768),
				timeout_seconds: z
					.number()
					.int()
					.min(1)
					.max(300)
					.optional()
					.describe(
						"Default 120 seconds; independent of the child task deadline.",
					),
			}),
			execute: async (input, ctx) => {
				if (!channel) throw new Error("Parent execution channel unavailable");
				return JSON.stringify(
					await channel.request("shell", input, ctx.signal),
				);
			},
		}),
	];
};
