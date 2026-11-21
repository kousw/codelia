import { promises as fs } from "node:fs";
import path from "node:path";
import { defineTool, type Tool } from "@codelia/core";
import { z } from "zod";
import { SandboxContext } from "../sandbox/context";
import { appendReadMetadata } from "../tools/content-hash";
import type { SubagentChannel, SubagentFileRead } from "./contracts";
import { clipUtf8 } from "./output";
import { createWorkspaceFiles } from "./workspace-files";

const clipJsonString = (text: string, limit: number): string => {
	const fits = (value: string) =>
		Buffer.byteLength(JSON.stringify(value)) <= limit;
	if (fits(text)) return text;
	const bytes = Buffer.byteLength(text);
	let low = 0;
	let high = bytes;
	while (low + 1 < high) {
		const probe = Math.floor((low + high) / 2);
		if (fits(clipUtf8(text, probe))) low = probe;
		else high = probe;
	}
	return clipUtf8(text, low);
};

/** Child-facing tools. A live child forwards I/O to its owning runtime. */
export const createSubagentReadTools = (
	root: string,
	protectedPaths?: readonly string[],
	options: {
		channel?: SubagentChannel;
		permits?: (target: string) => boolean;
	} = {},
): Tool[] => {
	const permits = options.permits ?? (() => true);
	const resolveWorkspace = async () => {
		const sandbox = await SandboxContext.create(await fs.realpath(root), {
			protectResources: true,
			extraProtectedPaths: protectedPaths,
		});
		return {
			sandbox,
			files: createWorkspaceFiles(sandbox.rootDir, protectedPaths),
		};
	};
	const call = async (
		operation: SubagentFileRead,
		input: unknown,
		signal: AbortSignal | undefined,
		local: () => Promise<string>,
	): Promise<string> => {
		if (!options.channel) return local();
		const reply = await options.channel.request(operation, input, signal);
		if (typeof reply !== "string") throw new Error("Invalid file read result");
		return reply;
	};
	const files = async (
		directory: string,
		{
			sandbox,
			files: { resolve, selectRead, blocked },
		}: Awaited<ReturnType<typeof resolveWorkspace>>,
		signal?: AbortSignal,
	): Promise<{ paths: string[]; truncated: boolean }> => {
		const root = sandbox.rootDir;
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
				if (blocked(child)) continue;
				if (entry.isDirectory()) {
					if (pending.length >= 2000) return { paths, truncated: true };
					pending.push(child);
				} else if (entry.isFile()) {
					const name = path.relative(root, child);
					const selected = await selectRead(name, sandbox).catch(
						() => undefined,
					);
					if (!selected || !permits(selected.target)) continue;
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
			execute: (input, ctx) =>
				call("read", input, ctx.signal, async () => {
					const {
						sandbox,
						files: { read },
					} = await resolveWorkspace();
					const content = await read(input.file_path, sandbox, permits);
					const preview = clipUtf8(
						content
							.split(/\r?\n/)
							.slice(
								input.offset ?? 0,
								(input.offset ?? 0) + (input.limit ?? 2000),
							)
							.map((line, i) => `${(input.offset ?? 0) + i + 1}: ${line}`)
							.join("\n"),
						64 * 1024 - 128,
					);
					// Keep control characters within the 240 KiB IPC frame.
					return appendReadMetadata(
						clipJsonString(preview, 220 * 1024),
						content,
					);
				}),
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
			execute: (input, ctx) =>
				call("read_line", input, ctx.signal, async () => {
					const {
						sandbox,
						files: { read },
					} = await resolveWorkspace();
					const content = await read(input.file_path, sandbox, permits);
					return appendReadMetadata(
						Array.from(content.split(/\r?\n/)[input.line_number - 1] ?? "")
							.slice(
								input.char_offset ?? 0,
								(input.char_offset ?? 0) + (input.char_limit ?? 10000),
							)
							.join(""),
						content,
					);
				}),
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
				call("list_files", input, ctx.signal, async () =>
					JSON.stringify(
						await files(
							input.directory ?? ".",
							await resolveWorkspace(),
							ctx.signal,
						),
					),
				),
		}),
		defineTool({
			name: "search_files",
			description:
				"Search literal text (not regex) in up to 1000 delegated workspace files. Skips symlinks, .git, node_modules, unreadable/binary/oversized files; at most 100 matches and 64 KiB output.",
			input: z.object({
				query: z.string().min(1).max(1000),
				directory: z.string().optional(),
			}),
			execute: (input, ctx) =>
				call("search_files", input, ctx.signal, async () => {
					const workspace = await resolveWorkspace();
					const found = await files(
						input.directory ?? ".",
						workspace,
						ctx.signal,
					);
					const matches: string[] = [];
					let skipped = 0;
					for (const name of found.paths) {
						ctx.signal?.throwIfAborted();
						let content: string;
						try {
							content = await workspace.files.read(
								name,
								workspace.sandbox,
								permits,
							);
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
					const matched = matches.join("\n");
					const preview = clipJsonString(matched, 60 * 1024);
					return JSON.stringify({
						content: preview,
						truncated:
							found.truncated ||
							matches.length >= 100 ||
							preview.length < matched.length,
						skipped,
					});
				}),
		}),
	];
};
