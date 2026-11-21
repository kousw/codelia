import { promises as fs } from "node:fs";
import path from "node:path";
import type { DependencyKey, Tool, ToolOutputCacheStore } from "@codelia/core";
import { defineTool } from "@codelia/core";
import { z } from "zod";
import { getSandboxContext, type SandboxContext } from "../sandbox/context";
import { createUnifiedDiff } from "../utils/diff";
import {
	assertExpectedContentHash,
	expectedContentHashSchema,
} from "./content-hash";
import { buildDiffPayload } from "./diff-payload";

export const createWriteTool = (
	sandboxKey: DependencyKey<SandboxContext>,
	outputCacheStore?: ToolOutputCacheStore | null,
): Tool =>
	defineTool({
		name: "write",
		description:
			"Write full UTF-8 text to a file, replacing any existing contents and creating parent directories if needed; supports the same full-content hash guard as edit.",
		input: z.object({
			file_path: z
				.string()
				.describe(
					"File path. Sandbox-bounded unless full-access mode is active.",
				),
			content: z
				.string()
				.describe("Full replacement UTF-8 text content to write."),
			expected_hash: expectedContentHashSchema,
		}),
		execute: async (input, ctx) => {
			let resolved: string;
			const sandbox = await getSandboxContext(ctx, sandboxKey);
			try {
				resolved = sandbox.resolvePath(input.file_path);
			} catch (error) {
				throw new Error(`Security error: ${String(error)}`);
			}

			try {
				let before = "";
				let fileExists = false;
				try {
					before = sandbox.hasResourceProtection
						? (
								await sandbox.readSelectedFile(input.file_path, "write")
							).toString("utf8")
						: await fs.readFile(resolved, "utf8");
					fileExists = true;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
						throw error;
					}
				}
				assertExpectedContentHash({
					expectedHash: input.expected_hash,
					fileExists,
					content: before,
					filePath: input.file_path,
				});
				if (sandbox.hasResourceProtection) {
					await sandbox.writeSelectedFile(
						input.file_path,
						input.content,
						ctx.signal,
					);
				} else {
					await fs.mkdir(path.dirname(resolved), { recursive: true });
					await fs.writeFile(resolved, input.content, "utf8");
				}
				const diffPayload = await buildDiffPayload({
					toolName: "write",
					diff: createUnifiedDiff(input.file_path, before, input.content),
					outputCacheStore,
					emptyDiff: `--- ${input.file_path}\n+++ ${input.file_path}\n@@ -0,0 +0,0 @@`,
					debugContext: `file=${input.file_path}`,
				});
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
