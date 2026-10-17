import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { ImageGenerationError } from "./http";

/** Export only to a new PNG in an existing workspace directory; never overwrite an original. */
export async function exportImageBytes(
	workspaceRoot: string,
	outputPath: string,
	bytes: Buffer,
): Promise<string> {
	if (
		!outputPath ||
		outputPath.length > 4096 ||
		[...outputPath].some(
			(c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
		) ||
		path.extname(outputPath).toLowerCase() !== ".png"
	)
		throw new ImageGenerationError(
			"Image export requires a PNG path in this workspace.",
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
