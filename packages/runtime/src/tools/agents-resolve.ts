import type { DependencyKey, Tool } from "@codelia/core";
import { defineTool } from "@codelia/core";
import { z } from "zod";
import type { AgentsResolver } from "../agents";
import { getAgentsResolver } from "../agents";
import { getSandboxContext, type SandboxContext } from "../sandbox/context";

export const createAgentsResolveTool = (
	sandboxKey: DependencyKey<SandboxContext>,
	agentsResolverKey: DependencyKey<AgentsResolver>,
): Tool =>
	defineTool({
		name: "agents_resolve",
		description:
			"Resolve AGENTS.md files applicable to a target path (metadata only).",
		input: z.object({
			path: z
				.string()
				.describe(
					"Target file or directory path to resolve AGENTS.md scope for.",
				),
		}),
		execute: async (input, ctx) => {
			let resolvedPath: string;
			try {
				const sandbox = await getSandboxContext(ctx, sandboxKey);
				resolvedPath = sandbox.resolvePath(input.path);
			} catch (error) {
				return `Security error: ${String(error)}`;
			}
			try {
				const resolver = await getAgentsResolver(ctx, agentsResolverKey);
				const files = await resolver.resolveForPath(resolvedPath);
				return {
					target_path: input.path,
					resolved_path: resolvedPath,
					count: files.length,
					files: files.map((file) => ({
						path: file.path,
						mtime_ms: Math.trunc(file.mtimeMs),
						size_bytes: file.sizeBytes,
						reason: file.reason,
					})),
				};
			} catch (error) {
				return `Error resolving AGENTS.md: ${String(error)}`;
			}
		},
	});
