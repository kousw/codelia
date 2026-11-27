import { promises as fs } from "node:fs";
import path from "node:path";
import type {
	LlmUsageRecord,
	SessionRecord,
	SessionStore,
	StoragePaths,
} from "@codelia/core";
import { hasDebugTopic } from "@codelia/logger";
import { resolveStoragePaths } from "./paths";
import { getProcessIdentity } from "./process-identity";
import {
	activeRunDirectory,
	runDatePath,
	usageLogPath,
	validateRunLogId,
} from "./run-log-paths";
import { type SessionRunRecorder, toRunLogRelPath } from "./session-run-index";
import { toUsageRecord } from "./usage-log";

export class SessionStoreWriterImpl implements SessionStore {
	readonly filePath: string;
	readonly usageFilePath: string;
	readonly diagnosticFilePath?: string;
	private readonly paths: StoragePaths;
	private readonly runId: string;
	private readonly startedAt: string;
	private sessionId?: string;
	private model?: LlmUsageRecord["model"];
	private readonly requestModels = new Map<number, LlmUsageRecord["model"]>();
	private activePath?: string;
	private writeChain: Promise<void> = Promise.resolve();
	private readonly runIndex?: SessionRunRecorder;
	private readonly onRunIndexError?: (error: unknown) => void;

	constructor(options: {
		runId: string;
		startedAt: string;
		paths?: StoragePaths;
		dump?: boolean;
		/** Records `session -> run` in state.db when the header is appended. */
		runIndex?: SessionRunRecorder;
		onRunIndexError?: (error: unknown) => void;
	}) {
		const paths = options.paths ?? resolveStoragePaths();
		this.paths = paths;
		this.runIndex = options.runIndex;
		this.onRunIndexError = options.onRunIndexError;
		this.runId = validateRunLogId(options.runId);
		this.startedAt = options.startedAt;
		const datePath = runDatePath(options.startedAt);
		this.filePath = path.join(
			paths.sessionsDir,
			datePath,
			`${this.runId}.jsonl`,
		);
		this.usageFilePath = usageLogPath(paths, datePath, this.runId);
		const dump = options.dump ?? hasDebugTopic("session-dump");
		if (dump)
			this.diagnosticFilePath = path.join(
				paths.sessionsDir,
				"diagnostics",
				datePath,
				`${this.runId}.jsonl`,
			);
	}

	private projectNormalRecord(
		record: SessionRecord,
	): SessionRecord | undefined {
		switch (record.type) {
			case "header": {
				this.sessionId = record.session_id;
				this.model = record.model;
				const { prompts: _prompts, tools: _tools, ...header } = record;
				return header;
			}
			case "llm.request":
				// Keep only accounting identity, never the request or its payloads.
				this.requestModels.set(record.seq, {
					provider: record.model?.provider ?? this.model?.provider,
					name: record.model?.name ?? this.model?.name,
				});
				return undefined;
			case "llm.response": {
				const model = this.requestModels.get(record.seq) ?? this.model;
				this.requestModels.delete(record.seq);
				return toUsageRecord(record, this.sessionId, model);
			}
			case "tool.output":
				return undefined;
			case "run.end":
				this.requestModels.clear();
				return record;
			default:
				return record;
		}
	}

	/** Indexed before the log line exists so a written log is never unindexed. */
	private async recordRun(sessionId: string, startedAt: string): Promise<void> {
		const relPath = toRunLogRelPath(this.paths.sessionsDir, this.filePath);
		if (!this.runIndex || !relPath) return;
		try {
			await this.runIndex.recordSessionRun({
				session_id: sessionId,
				run_id: this.runId,
				rel_path: relPath,
				started_at: startedAt,
			});
		} catch (error) {
			// The latest-run check in listSessionRuns falls back to a rescan.
			this.onRunIndexError?.(error);
		}
	}

	append(record: SessionRecord): Promise<void> {
		const markerSessionId =
			record.type === "header" ? record.session_id : undefined;
		const startedAt = record.type === "header" ? record.started_at : undefined;
		const terminal = record.type === "run.end";
		let normal: string | undefined;
		let dump: string | undefined;
		let usage: string | undefined;
		try {
			if (this.diagnosticFilePath) dump = `${JSON.stringify(record)}\n`;
			const projected = this.projectNormalRecord(record);
			if (projected) {
				normal = `${JSON.stringify(projected)}\n`;
				if (record.type === "llm.response") usage = normal;
			}
		} catch (error) {
			return Promise.reject(error);
		}
		if (normal === undefined && dump === undefined && usage === undefined)
			return this.writeChain;
		const write = this.writeChain.then(async () => {
			if (markerSessionId) {
				await this.recordRun(markerSessionId, startedAt ?? this.startedAt);
				const directory = activeRunDirectory(this.paths, markerSessionId);
				await fs.mkdir(directory, { recursive: true });
				this.activePath = path.join(directory, `${this.runId}.json`);
				await fs.writeFile(
					this.activePath,
					JSON.stringify({
						pid: process.pid,
						identity: await getProcessIdentity(process.pid, {
							canonicalEnvironment: true,
						}),
					}),
					{ flag: "wx", mode: 0o600 },
				);
			}
			for (const [file, line] of [
				[this.usageFilePath, usage],
				[this.filePath, normal],
				[this.diagnosticFilePath, dump],
			] as const) {
				if (!file || line === undefined) continue;
				await fs.mkdir(path.dirname(file), { recursive: true });
				await fs.appendFile(file, line, { encoding: "utf8", mode: 0o600 });
			}
			if (terminal && this.activePath) {
				await fs.unlink(this.activePath);
				this.activePath = undefined;
			}
		});
		this.writeChain = write.catch(() => {});
		return write;
	}
}
