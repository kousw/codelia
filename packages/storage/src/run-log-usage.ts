import { promises as fs } from "node:fs";
import path from "node:path";
import type {
	LlmResponseRecord,
	LlmUsageRecord,
	StoragePaths,
} from "@codelia/core";
import { usageLogPath } from "./run-log-paths";
import { toUsageRecord } from "./usage-log";
import { readRunLogRecordParts } from "./run-log-records";
import { RunLogRequestModel } from "./run-log-request-model";

const MAX_USAGE_LINE_BYTES = 16 * 1024 * 1024;

type RunLogUsageSource = {
	file: string;
	datePath: string;
	runId: string;
	sessionId: string;
	model?: LlmUsageRecord["model"];
};

type RequestIdentity = {
	type: "request-identity";
	seq: number;
	model?: LlmUsageRecord["model"];
};

/** Skip huge input snapshots without buffering/parsing their image payloads. */
async function* readUsageRecords(
	file: string,
): AsyncGenerator<LlmUsageRecord | LlmResponseRecord | RequestIdentity> {
	let parts: Buffer[] = [];
	let length = 0;
	let request: RunLogRequestModel | undefined;
	for await (const part of readRunLogRecordParts(file)) {
		if (part.type === "llm.request") {
			if (part.start) request = new RunLogRequestModel();
			request?.push(part.data);
			if (part.end) {
				const identity = request?.finish();
				if (identity) yield { type: "request-identity", ...identity };
				request = undefined;
			}
			continue;
		}
		if (part.type !== "llm.usage" && part.type !== "llm.response") continue;
		length += part.data.length;
		if (length > MAX_USAGE_LINE_BYTES)
			throw new Error("Usage record is too large to migrate safely");
		parts.push(part.data);
		if (part.end) {
			yield JSON.parse(Buffer.concat(parts, length).toString("utf8"));
			parts = [];
			length = 0;
		}
	}
}

export async function preserveRunUsage(
	paths: StoragePaths,
	source: RunLogUsageSource,
): Promise<LlmUsageRecord[]> {
	const destination = usageLogPath(paths, source.datePath, source.runId);
	const records = new Map<number, LlmUsageRecord>();
	const requestModels = new Map<number, LlmUsageRecord["model"]>();
	try {
		const stat = await fs.lstat(destination);
		if (!stat.isFile()) throw new Error("Invalid usage log");
		for await (const record of readUsageRecords(destination))
			if (record.type === "llm.usage")
				records.set(
					record.seq,
					toUsageRecord(record, source.sessionId, record.model),
				);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	for await (const record of readUsageRecords(source.file)) {
		if (record.type === "request-identity") {
			requestModels.set(record.seq, record.model);
			const known = records.get(record.seq);
			if (known)
				records.set(
					record.seq,
					toUsageRecord(known, source.sessionId, {
						provider: known.model?.provider ?? record.model?.provider,
						name: known.model?.name ?? record.model?.name,
					}),
				);
			continue;
		}
		if (
			record.run_id !== source.runId ||
			!Number.isSafeInteger(record.seq) ||
			record.seq < 1
		)
			throw new Error("Mismatched usage run");
		// Compact accounting is already canonical; a diagnostic response must not
		// erase its provider identity or other known fields during migration.
		if (record.type === "llm.response" && records.has(record.seq)) continue;
		const usage = toUsageRecord(record, source.sessionId, {
			provider:
				records.get(record.seq)?.model?.provider ??
				(record.type === "llm.usage" ? record.model?.provider : undefined) ??
				requestModels.get(record.seq)?.provider,
			name:
				records.get(record.seq)?.model?.name ??
				(record.type === "llm.usage" ? record.model?.name : undefined) ??
				requestModels.get(record.seq)?.name,
		});
		records.set(usage.seq, usage);
	}
	if (records.size === 0) return [];
	const ordered = [...records.values()]
		.sort((a, b) => a.seq - b.seq)
		.map((record) =>
			toUsageRecord(record, source.sessionId, {
				provider: record.model?.provider ?? source.model?.provider,
				name: record.model?.name ?? source.model?.name,
			}),
		);
	await fs.mkdir(path.dirname(destination), { recursive: true });
	const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
	try {
		const lines = ordered.map((record) => JSON.stringify(record)).join("\n");
		await fs.writeFile(temporary, `${lines}\n`, { mode: 0o600 });
		await fs.rename(temporary, destination);
	} finally {
		await fs.rm(temporary, { force: true });
	}
	return ordered;
}
