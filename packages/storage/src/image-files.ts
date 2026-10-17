import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

export const imageHash = (bytes: Buffer): string =>
	createHash("sha256").update(bytes).digest("hex");

export async function readImageFileBounded(
	file: string,
	limit: number,
): Promise<Buffer> {
	const handle = await open(
		file,
		constants.O_RDONLY |
			(constants.O_NOFOLLOW ?? 0) |
			(constants.O_NONBLOCK ?? 0),
	);
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size > limit)
			throw new Error("Invalid artifact file");
		const bytes = Buffer.alloc(stat.size + 1);
		let offset = 0;
		while (offset < bytes.length) {
			const read = await handle.read(
				bytes,
				offset,
				bytes.length - offset,
				offset,
			);
			if (!read.bytesRead) break;
			offset += read.bytesRead;
		}
		if (offset !== stat.size) throw new Error("Artifact changed during read");
		return bytes.subarray(0, offset);
	} finally {
		await handle.close();
	}
}
