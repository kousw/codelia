import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export type AtomicWriteOptions = {
	mode?: number;
};

/**
 * Write UTF-8 text atomically via a sibling temp file, fsync, and rename.
 * Ensures restrictive permissions (default 0o600) and cleans up on error.
 */
export const writeFileAtomic = async (
	targetPath: string,
	data: string,
	options: AtomicWriteOptions = {},
): Promise<void> => {
	const mode = options.mode ?? 0o600;
	const dir = path.dirname(targetPath);
	const base = path.basename(targetPath);
	const temporary = path.join(dir, `.${base}.${randomUUID()}.tmp`);

	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(temporary, "wx", mode);
		await handle.writeFile(data, "utf8");
		await handle.sync();
		await handle.close();
		handle = undefined;
		try {
			await fs.chmod(temporary, mode);
		} catch {
			// Ignore chmod errors on platforms without POSIX modes (e.g. Windows).
		}
		await fs.rename(temporary, targetPath);
		try {
			await fs.chmod(targetPath, mode);
		} catch {
			// Ignore chmod errors on platforms without POSIX modes (e.g. Windows).
		}
	} catch (error) {
		if (handle) {
			await handle.close().catch(() => undefined);
		}
		await fs.unlink(temporary).catch(() => undefined);
		throw error;
	}
};
