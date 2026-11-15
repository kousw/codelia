import { constants, existsSync, promises as fs } from "node:fs";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";

/** Plain wins if both exist after interrupted compression; never replay twice. */
export const resolveRunLogPath = (file: string): string =>
	existsSync(file) ? file : file.endsWith(".gz") ? file : `${file}.gz`;

export async function* readRunLogChunks(file: string): AsyncGenerator<Buffer> {
	let resolved = resolveRunLogPath(file);
	let handle: Awaited<ReturnType<typeof fs.open>>;
	try {
		handle = await fs.open(
			resolved,
			constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
		);
	} catch (error) {
		if (
			(error as NodeJS.ErrnoException).code !== "ENOENT" ||
			file.endsWith(".gz")
		)
			throw error;
		resolved = `${file}.gz`;
		handle = await fs.open(
			resolved,
			constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
		);
	}
	const source = handle.createReadStream();
	const input = resolved.endsWith(".gz") ? source.pipe(createGunzip()) : source;
	const sourceError = (error: Error) => input.destroy(error);
	if (input !== source) source.on("error", sourceError);
	try {
		for await (const chunk of input)
			yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
	} finally {
		input.destroy();
		source.destroy();
		source.off("error", sourceError);
	}
}

export async function* readRunLogLines(file: string): AsyncGenerator<string> {
	const input = Readable.from(readRunLogChunks(file));
	const lines = createInterface({ input, crlfDelay: Infinity });
	try {
		for await (const line of lines) yield line;
	} finally {
		lines.close();
		input.destroy();
	}
}
