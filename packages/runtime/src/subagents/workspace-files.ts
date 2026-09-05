import { constants, promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { hashUtf8Content } from "../tools/content-hash";

export const MAX_CHILD_FILE_BYTES = 4 * 1024 * 1024;
const readContent = async (handle: FileHandle): Promise<string> => {
	const buffer = Buffer.alloc(MAX_CHILD_FILE_BYTES + 1);
	const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
	if (bytesRead > MAX_CHILD_FILE_BYTES) throw new Error("File exceeds 4 MiB");
	return buffer.subarray(0, bytesRead).toString("utf8");
};

// All child file mutations run in the owning parent process. Hold only the
// check/write critical section, never ownership across model steps. A single
// queue also covers hard links and case aliases to the same file.
let pendingUpdate: Promise<void> = Promise.resolve();

export const createWorkspaceFiles = (root: string) => {
	const resolve = async (
		name: string,
		allowMissing = false,
	): Promise<string> => {
		const candidate = path.resolve(root, name);
		const relative = path.relative(root, candidate);
		if (
			relative === ".." ||
			relative.startsWith(`..${path.sep}`) ||
			path.isAbsolute(relative)
		)
			throw new Error("Path outside delegated workspace");
		let part = root;
		for (const segment of relative.split(path.sep).filter(Boolean)) {
			part = path.join(part, segment);
			try {
				if ((await fs.lstat(part)).isSymbolicLink())
					throw new Error(
						"Symbolic links are not available to delegated tools",
					);
			} catch (error) {
				if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT")
					continue;
				throw error;
			}
		}
		return candidate;
	};
	const read = async (name: string): Promise<string> => {
		const handle = await fs.open(
			await resolve(name),
			constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
		);
		try {
			const stat = await handle.stat();
			if (!stat.isFile() || stat.size > MAX_CHILD_FILE_BYTES)
				throw new Error("Expected a regular text file up to 4 MiB");
			return await readContent(handle);
		} finally {
			await handle.close();
		}
	};
	const updateFile = async (
		name: string,
		expected: string,
		transform: (content: string) => string,
	): Promise<string> => {
		const file = await resolve(name, expected === "missing");
		if (expected === "missing") {
			await fs.mkdir(path.dirname(file), { recursive: true });
			await resolve(name, true);
		}
		const handle = await fs.open(
			file,
			expected === "missing"
				? "wx"
				: constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
		);
		try {
			const stat = await handle.stat();
			if (!stat.isFile() || stat.size > MAX_CHILD_FILE_BYTES)
				throw new Error("Expected regular text file up to 4 MiB");
			const before = expected === "missing" ? "" : await readContent(handle);
			if (expected !== "missing" && hashUtf8Content(before) !== expected)
				throw new Error(
					"Hash mismatch: another agent changed this file. Read it again and coordinate before editing.",
				);
			const after = transform(before);
			const buffer = Buffer.from(after);
			if (buffer.length > MAX_CHILD_FILE_BYTES)
				throw new Error("File exceeds 4 MiB");
			let position = 0;
			while (position < buffer.length) {
				const result = await handle.write(
					buffer,
					position,
					buffer.length - position,
					position,
				);
				if (!result.bytesWritten) throw new Error("Write made no progress");
				position += result.bytesWritten;
			}
			await handle.truncate(buffer.length);
			return hashUtf8Content(after);
		} finally {
			await handle.close();
		}
	};
	const update = async (
		name: string,
		expected: string,
		transform: (content: string) => string,
		signal?: AbortSignal,
	): Promise<string> => {
		const previous = pendingUpdate;
		let release!: () => void;
		pendingUpdate = new Promise<void>((done) => {
			release = done;
		});
		try {
			await previous;
			signal?.throwIfAborted();
			return await updateFile(name, expected, transform);
		} finally {
			release();
		}
	};
	return { resolve, read, update };
};
