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
			"Load a local image file and return it as a multimodal content part.",
		input: z.object({
			file_path: z
				.string()
				.describe(
					"Image file path. Sandbox-bounded unless full-access mode is active.",
				),
			detail: z
				.enum(["auto", "low", "high"])
				.optional()
				.describe("Image detail hint. Default auto."),
			max_bytes: z
				.number()
				.int()
				.positive()
				.max(MAX_MAX_BYTES)
				.optional()
				.describe("Max allowed file size in bytes. Default 5242880."),
		}),
		execute: async (input, ctx) => {
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
