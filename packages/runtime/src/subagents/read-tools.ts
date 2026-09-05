import { promises as fs } from "node:fs";
import path from "node:path";
import { defineTool, type Tool } from "@codelia/core";
import { z } from "zod";
import { appendReadMetadata } from "../tools/content-hash";
import { clipUtf8 } from "./output";
import { createWorkspaceFiles } from "./workspace-files";

/** Child-only bounded filesystem tools, without subprocesses. */
export const createSubagentReadTools = (root: string): Tool[] => {
	const { resolve, read } = createWorkspaceFiles(root);
	const files = async (
		directory: string,
		signal?: AbortSignal,
	): Promise<{ paths: string[]; truncated: boolean }> => {
		const paths: string[] = [];
		const pending = [await resolve(directory)];
		let visited = 0;
		let bytes = 0;
		while (pending.length && paths.length < 1000 && visited++ < 2000) {
			signal?.throwIfAborted();
			const dir = pending.shift();
			if (!dir) break;
			const entries = await fs.opendir(await resolve(path.relative(root, dir)));
			for await (const entry of entries) {
				if (
					entry.isSymbolicLink() ||
					entry.name === ".git" ||
					entry.name === "node_modules"
				)
					continue;
				const child = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					if (pending.length >= 2000) return { paths, truncated: true };
					pending.push(child);
				} else if (entry.isFile()) {
					const name = path.relative(root, child);
					bytes += Buffer.byteLength(JSON.stringify(name)) + 1;
					if (bytes > 60 * 1024) return { paths, truncated: true };
					paths.push(name);
				}
				if (paths.length >= 1000) return { paths, truncated: true };
			}
		}
		return { paths, truncated: pending.length > 0 };
	};
	return [
		defineTool({
			name: "read",
			description:
				"Read a bounded UTF-8 file preview inside the delegated workspace. No symlinks; files up to 4 MiB; output at most 64 KiB including full content_sha256 for guarded edits.",
			input: z.object({
				file_path: z.string(),
				offset: z
					.number()
					.int()
					.min(0)
					.optional()
					.describe("0-based line offset; default 0."),
				limit: z
					.number()
					.int()
					.min(1)
					.max(2000)
					.optional()
					.describe("Maximum lines; default 2000."),
			}),
			execute: async (input) => {
				const content = await read(input.file_path);
				return appendReadMetadata(
					clipUtf8(
						content
							.split(/\r?\n/)
							.slice(
								input.offset ?? 0,
								(input.offset ?? 0) + (input.limit ?? 2000),
							)
							.map((line, i) => `${(input.offset ?? 0) + i + 1}: ${line}`)
							.join("\n"),
						64 * 1024 - 128,
					),
					content,
				);
			},
		}),
		defineTool({
			name: "read_line",
			description:
				"Read a page of one UTF-8 text line inside the delegated workspace; no symlinks, file cap 4 MiB.",
			input: z.object({
				file_path: z.string(),
				line_number: z.number().int().min(1).describe("1-based line number."),
				char_offset: z.number().int().min(0).optional(),
				char_limit: z.number().int().min(1).max(16000).optional(),
			}),
			execute: async (input) => {
				const content = await read(input.file_path);
				return appendReadMetadata(
					Array.from(content.split(/\r?\n/)[input.line_number - 1] ?? "")
						.slice(
							input.char_offset ?? 0,
							(input.char_offset ?? 0) + (input.char_limit ?? 10000),
						)
						.join(""),
					content,
				);
			},
		}),
		defineTool({
			name: "list_files",
			description:
				"List up to 1000 workspace-relative files recursively, bounded to 64 KiB. Skips symlinks, .git and node_modules; reports truncation.",
			input: z.object({
				directory: z
					.string()
					.optional()
					.describe("Workspace-relative directory; default '.'"),
			}),
			execute: async (input, ctx) =>
				JSON.stringify(await files(input.directory ?? ".", ctx.signal)),
		}),
		defineTool({
			name: "search_files",
			description:
				"Search literal text (not regex) in up to 1000 delegated workspace files. Skips symlinks, .git, node_modules, unreadable/binary/oversized files; at most 100 matches and 64 KiB output.",
			input: z.object({
				query: z.string().min(1).max(1000),
				directory: z.string().optional(),
			}),
			execute: async (input, ctx) => {
				const found = await files(input.directory ?? ".", ctx.signal);
				const matches: string[] = [];
				let skipped = 0;
				for (const name of found.paths) {
					ctx.signal?.throwIfAborted();
					let content: string;
					try {
						content = await read(name);
					} catch {
						skipped++;
						continue;
					} // A search may skip unreadable files; expose the count.
					if (content.includes("\0")) {
						skipped++;
						continue;
					}
					for (const [i, line] of content.split(/\r?\n/).entries()) {
						if (line.includes(input.query))
							matches.push(`${name}:${i + 1}: ${clipUtf8(line, 1000)}`);
						if (matches.length >= 100) break;
					}
					if (matches.length >= 100) break;
				}
				return JSON.stringify({
					content: clipUtf8(matches.join("\n"), 60 * 1024),
					truncated:
						found.truncated ||
						matches.length >= 100 ||
						Buffer.byteLength(matches.join("\n")) > 60 * 1024,
					skipped,
				});
			},
		}),
	];
};
