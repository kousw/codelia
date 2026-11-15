import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import type { LlmUsageRecord } from "@codelia/core";
import { projectArchivedRunLog } from "./run-log-archive";

export async function prepareCompressedLog(
	file: string,
	usage: readonly LlmUsageRecord[],
): Promise<{ temporary: string; size: number }> {
	const temporary = `${file}.${crypto.randomUUID()}.gz.tmp`;
	const hash = createHash("sha256");
	let bytes = 0;
	try {
		await pipeline(
			Readable.from(projectArchivedRunLog(file, usage)),
			new Transform({
				transform(chunk, _encoding, callback) {
					bytes += chunk.length;
					hash.update(chunk);
					callback(null, chunk);
				},
			}),
			createGzip(),
			createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
		);
		const expected = hash.digest("hex");
		const verification = createHash("sha256");
		let decoded = 0;
		await pipeline(
			createReadStream(temporary),
			createGunzip(),
			new Transform({
				transform(chunk, _encoding, callback) {
					decoded += chunk.length;
					verification.update(chunk);
					callback();
				},
			}),
		);
		if (decoded !== bytes || verification.digest("hex") !== expected)
			throw new Error("Compressed run log verification failed");
		const persisted = await fs.open(temporary, "r+");
		try {
			await persisted.sync();
		} finally {
			await persisted.close();
		}
		return { temporary, size: (await fs.stat(temporary)).size };
	} catch (error) {
		await fs.rm(temporary, { force: true });
		throw error;
	}
}
