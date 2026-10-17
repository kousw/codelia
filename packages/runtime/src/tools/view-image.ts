import { promises as fs } from "node:fs";
import path from "node:path";
import type { DependencyKey, Tool } from "@codelia/core";
import { defineTool } from "@codelia/core";
import { z } from "zod";
import { getSandboxContext, type SandboxContext } from "../sandbox/context";

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const MAX_MAX_BYTES = 10 * 1024 * 1024;

const MIME_BY_EXTENSION: Record<
	string,
	"image/png" | "image/jpeg" | "image/webp" | "image/gif"
> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
};

const resolveImageMime = (
	filePath: string,
): "image/png" | "image/jpeg" | "image/webp" | "image/gif" | null => {
	return MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? null;
};

export const createViewImageTool = (
	sandboxKey: DependencyKey<SandboxContext>,
): Tool =>
	defineTool({
		name: "view_image",
		description:
			"Inspect one local image or direct HTTP(S) image URL; URLs are passed to the model provider without local download (provider URL support required; Moonshot unsupported).",
		input: z
			.object({
				file_path: z
					.string()
					.min(1)
					.optional()
					.describe(
						"Local png/jpeg/webp/gif path; provide exactly one of file_path or url. Sandbox-bounded unless full-access mode is active.",
					),
				url: z
					.url({ protocol: /^https?$/ })
					.refine((value) => {
						if (!URL.canParse(value)) return false;
						const parsed = new URL(value);
						return !parsed.username && !parsed.password;
					}, "Image URL must not contain credentials")
					.optional()
					.describe(
						"Publicly accessible direct image URL, not a web page; provide exactly one of url or file_path. Provider fetches it; runtime does not verify availability, format, or size. Do not include secrets.",
					),
				detail: z
					.enum(["auto", "low", "high"])
					.optional()
					.describe(
						"Model image-detail hint (`auto`/`low`/`high`). Default auto.",
					),
				max_bytes: z
					.number()
					.int()
					.positive()
					.max(MAX_MAX_BYTES)
					.optional()
					.describe(
						"Local files only: max bytes. Default 5242880, Max 10485760; omit with url.",
					),
			})
			.refine(
				(input) =>
					(input.file_path !== undefined) !== (input.url !== undefined),
				"Provide exactly one of file_path or url",
			)
			.refine(
				(input) => input.url === undefined || input.max_bytes === undefined,
				"max_bytes is only supported for local files",
			),
		execute: async (input, ctx) => {
			if (input.url !== undefined) {
				return [
					{
						type: "text",
						text: "Image URL supplied for provider inspection (not fetched locally).\n",
					},
					{
						type: "image_url",
						image_url: { url: input.url, detail: input.detail ?? "auto" },
					},
				];
			}
			if (input.file_path === undefined) {
				throw new Error("Provide exactly one of file_path or url");
			}
			let resolved: string;
			try {
				const sandbox = await getSandboxContext(ctx, sandboxKey);
				resolved = sandbox.resolvePath(input.file_path);
			} catch (error) {
				throw new Error(`Security error: ${String(error)}`);
			}

			const mediaType = resolveImageMime(input.file_path);
			if (!mediaType) {
				return `Unsupported image type: ${input.file_path}`;
			}

			try {
				const stat = await fs.stat(resolved);
				if (stat.isDirectory()) {
					return `Path is a directory: ${input.file_path}`;
				}
				const maxBytes = input.max_bytes ?? DEFAULT_MAX_BYTES;
				if (stat.size > maxBytes) {
					return `Image too large: ${input.file_path} (${stat.size} bytes > ${maxBytes} bytes)`;
				}
				const buffer = await fs.readFile(resolved);
				const dataUrl = `data:${mediaType};base64,${buffer.toString("base64")}`;
				return [
					{
						type: "text",
						text: `Image loaded: ${input.file_path}\n`,
					},
					{
						type: "image_url",
						image_url: {
							url: dataUrl,
							media_type: mediaType,
							detail: input.detail ?? "auto",
						},
					},
				];
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") {
					return `File not found: ${input.file_path}`;
				}
				return `Error loading image: ${String(error)}`;
			}
		},
	});
