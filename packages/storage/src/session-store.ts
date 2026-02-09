import { promises as fs } from "node:fs";
import path from "node:path";
import type { SessionRecord, SessionStore, StoragePaths } from "@codelia/core";
import { resolveStoragePaths } from "./paths";

const pad2 = (value: number): string => String(value).padStart(2, "0");

const resolveDateParts = (
	startedAt: string,
): { year: string; month: string; day: string } => {
	const parsed = new Date(startedAt);
	const date = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
	return {
		year: String(date.getUTCFullYear()),
		month: pad2(date.getUTCMonth() + 1),
		day: pad2(date.getUTCDate()),
	};
};

export class SessionStoreWriterImpl implements SessionStore {
	private readonly filePath: string;
	private readonly ensureDir: Promise<void>;
	private writeChain: Promise<void> = Promise.resolve();

	constructor(options: {
		runId: string;
		startedAt: string;
		paths?: StoragePaths;
	}) {
		const paths = options.paths ?? resolveStoragePaths();
		const parts = resolveDateParts(options.startedAt);
		const baseDir = path.join(
			paths.sessionsDir,
			parts.year,
			parts.month,
			parts.day,
		);
		this.filePath = path.join(baseDir, `${options.runId}.jsonl`);
		this.ensureDir = fs.mkdir(baseDir, { recursive: true }).then(() => {});
	}

	append(record: SessionRecord): Promise<void> {
		let line: string;
		try {
			line = `${JSON.stringify(record)}\n`;
		} catch (error) {
			return Promise.reject(error);
		}
		const write = this.writeChain.then(async () => {
			await this.ensureDir;
			await fs.appendFile(this.filePath, line, "utf8");
		});
		this.writeChain = write.catch(() => {});
		return write;
	}
}
