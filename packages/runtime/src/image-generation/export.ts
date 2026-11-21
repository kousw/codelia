import { open, realpath } from "node:fs/promises";
import path from "node:path";
import type { SandboxContext } from "../sandbox/context";
import { ImageGenerationError } from "./http";

/** Export original bytes to a new matching-format file; never overwrite an original. */
export async function exportImageBytes(
	workspaceRoot: string,
	outputPath: string,
	bytes: Buffer,
	mediaType: "image/png" | "image/jpeg" = "image/png",
	sandbox?: SandboxContext,
	signal?: AbortSignal,
): Promise<string> {
	const extension = path.extname(outputPath).toLowerCase();
	if (
		!outputPath ||
		outputPath.length > 4096 ||
		[...outputPath].some(
			(c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
		) ||
		(mediaType === "image/png"
			? extension !== ".png"
			: extension !== ".jpg" && extension !== ".jpeg")
	)
		throw new ImageGenerationError(
			"Image export path must match the original PNG or JPEG format in this workspace.",
		);
	const target = path.resolve(workspaceRoot, outputPath);
	try {
		const root = await realpath(workspaceRoot);
		const parent = await realpath(path.dirname(target));
		const relative = path.relative(root, parent);
		if (
			relative === ".." ||
			relative.startsWith(`..${path.sep}`) ||
			path.isAbsolute(relative)
		)
			throw new Error("outside workspace");
		const destination = path.join(parent, path.basename(target));
		if (sandbox?.hasResourceProtection) {
			await sandbox.createSelectedFile(outputPath, bytes, 0o600, signal);
			return destination;
		}
		const file = await open(destination, "wx", 0o600);
		try {
			await file.writeFile(bytes);
			await file.sync();
		} finally {
			await file.close();
		}
		return destination;
	} catch {
		throw new ImageGenerationError(
			"Image export failed: destination must be a new file in an existing workspace directory. No original was modified.",
		);
	}
}
