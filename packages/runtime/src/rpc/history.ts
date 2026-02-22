import type { Dirent } from "node:fs";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import type {
	AgentEvent,
	SessionRecord,
	SessionStateStore,
} from "@codelia/core";
import {
	RPC_ERROR_CODE,
	type RpcNotification,
	type SessionHistoryParams,
	type SessionHistoryResult,
	type SessionListParams,
	type SessionListResult,
} from "@codelia/protocol";
import { resolveStoragePaths } from "@codelia/storage";
import { send, sendError, sendResult } from "./transport";

export type HistoryHandlersDeps = {
	sessionStateStore: SessionStateStore;
	log: (message: string) => void;
};

const DEFAULT_HISTORY_RUNS = 20;
const DEFAULT_HISTORY_EVENTS = 1500;

type RunFile = {
	path: string;
	run_id: string;
	started_at: string;
};

type RunHeader = {
	type?: string;
	run_id?: string;
	session_id?: string;
	started_at?: string;
};

const runStartInputToHiddenMessage = (
	input: Extract<SessionRecord, { type: "run.start" }>["input"] | undefined,
): string => {
	if (!input) {
		return "";
	}
	if (input.type === "text") {
		return input.text;
	}
	if (!Array.isArray(input.parts)) {
		return "";
	}
	let message = "";
	for (const part of input.parts) {
		if (!part || typeof part !== "object") {
			continue;
		}
		if (part.type === "text") {
			message += part.text;
			continue;
		}
		if (part.type === "image_url") {
			message += "[image]";
		}
	}
	return message;
};

const parseRunHeader = (headerLine: string): RunHeader | null => {
	try {
		const header = JSON.parse(headerLine) as RunHeader;
		if (!header || typeof header !== "object") return null;
		if (header.type !== "header") return null;
		return header;
	} catch {
		return null;
	}
};

const readFirstLine = async (filePath: string): Promise<string | null> => {
	const stream = createReadStream(filePath, { encoding: "utf8" });
	const reader = createInterface({
		input: stream,
		crlfDelay: Number.POSITIVE_INFINITY,
	});
	try {
		for await (const line of reader) {
			return line;
		}
		return null;
	} finally {
		reader.close();
		stream.destroy();
	}
};

const collectRunCandidates = async (
	log: (message: string) => void,
): Promise<Array<{ path: string; mtimeMs: number }>> => {
	const paths = resolveStoragePaths();
	const sessionsDir = paths.sessionsDir;
	let yearEntries: Dirent[];
	try {
		yearEntries = (await fs.readdir(sessionsDir, {
			withFileTypes: true,
			encoding: "utf8",
		})) as Dirent[];
	} catch (error) {
		log(`session.history list error: ${String(error)}`);
		return [];
	}
	const candidates: { path: string; mtimeMs: number }[] = [];
	for (const yearEntry of yearEntries) {
		if (!yearEntry.isDirectory()) continue;
		if (!/^\d{4}$/.test(yearEntry.name)) continue;
		const yearPath = path.join(sessionsDir, yearEntry.name);
		let monthEntries: Dirent[];
		try {
			monthEntries = (await fs.readdir(yearPath, {
				withFileTypes: true,
				encoding: "utf8",
			})) as Dirent[];
		} catch {
			continue;
		}
		for (const monthEntry of monthEntries) {
			if (!monthEntry.isDirectory()) continue;
			if (!/^\d{2}$/.test(monthEntry.name)) continue;
			const monthPath = path.join(yearPath, monthEntry.name);
			let dayEntries: Dirent[];
			try {
				dayEntries = (await fs.readdir(monthPath, {
					withFileTypes: true,
					encoding: "utf8",
				})) as Dirent[];
			} catch {
				continue;
			}
			for (const dayEntry of dayEntries) {
				if (!dayEntry.isDirectory()) continue;
				if (!/^\d{2}$/.test(dayEntry.name)) continue;
				const dayPath = path.join(monthPath, dayEntry.name);
				let files: Dirent[];
				try {
					files = (await fs.readdir(dayPath, {
						withFileTypes: true,
						encoding: "utf8",
					})) as Dirent[];
				} catch {
					continue;
				}
				for (const file of files) {
					if (!file.isFile()) continue;
					if (!file.name.endsWith(".jsonl")) continue;
					const filePath = path.join(dayPath, file.name);
					try {
						const stat = await fs.stat(filePath);
						candidates.push({ path: filePath, mtimeMs: stat.mtimeMs });
					} catch {}
				}
			}
		}
	}
	candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return candidates;
};

const collectSessionRuns = async (
	sessionId: string,
	maxRuns: number,
	log: (message: string) => void,
): Promise<RunFile[]> => {
	const candidates = await collectRunCandidates(log);
	const runs: RunFile[] = [];
	for (const candidate of candidates) {
		if (runs.length >= maxRuns) break;
		let headerLine: string | null = null;
		try {
			headerLine = await readFirstLine(candidate.path);
		} catch {
			continue;
		}
		if (!headerLine) continue;
		const header = parseRunHeader(headerLine);
		if (!header) continue;
		if (header.session_id !== sessionId) continue;
		const runId = header.run_id ?? path.basename(candidate.path, ".jsonl");
		const startedAt =
			header.started_at ?? new Date(candidate.mtimeMs).toISOString();
		runs.push({
			path: candidate.path,
			run_id: runId,
			started_at: startedAt,
		});
	}
	runs.sort((a, b) => a.started_at.localeCompare(b.started_at));
	return runs;
};

const readJsonl = async function* (filePath: string): AsyncGenerator<string> {
	const stream = createReadStream(filePath, { encoding: "utf8" });
	let buffer = "";
	for await (const chunk of stream) {
		buffer += chunk;
		let index = buffer.indexOf("\n");
		while (index >= 0) {
			const line = buffer.slice(0, index).trim();
			buffer = buffer.slice(index + 1);
			if (line) {
				yield line;
			}
			index = buffer.indexOf("\n");
		}
	}
	const tail = buffer.trim();
	if (tail) {
		yield tail;
	}
};

const sendHistoryEvent = (
	runId: string,
	seq: number,
	event: AgentEvent,
): void => {
	const notify: RpcNotification = {
		jsonrpc: "2.0",
		method: "agent.event",
		params: {
			run_id: runId,
			seq,
			event,
		},
	};
	send(notify);
};

export const createHistoryHandlers = ({
	sessionStateStore,
	log,
}: HistoryHandlersDeps): {
	handleSessionList: (id: string, params: SessionListParams) => Promise<void>;
	handleSessionHistory: (
		id: string,
		params: SessionHistoryParams,
	) => Promise<void>;
} => {
	const handleSessionList = async (
		id: string,
		params: SessionListParams,
	): Promise<void> => {
		const limit = params?.limit ?? 50;
		let sessions: SessionListResult["sessions"];
		try {
			sessions = await sessionStateStore.list();
		} catch (error) {
			sendError(id, {
				code: RPC_ERROR_CODE.SESSION_LIST_FAILED,
				message: `session list failed: ${String(error)}`,
			});
			return;
		}
		const sorted = sessions.sort((a, b) =>
			b.updated_at.localeCompare(a.updated_at),
		);
		const filtered = limit > 0 ? sorted.slice(0, limit) : sorted.slice();
		const result: SessionListResult = { sessions: filtered };
		sendResult(id, result);
	};

	const handleSessionHistory = async (
		id: string,
		params: SessionHistoryParams,
	): Promise<void> => {
		const sessionId = params?.session_id?.trim();
		if (!sessionId) {
			sendError(id, {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: "session_id is required",
			});
			return;
		}
		const maxRuns = Math.max(0, params?.max_runs ?? DEFAULT_HISTORY_RUNS);
		const maxEvents = Math.max(0, params?.max_events ?? DEFAULT_HISTORY_EVENTS);
		if (maxRuns === 0 || maxEvents === 0) {
			const result: SessionHistoryResult = {
				runs: 0,
				events_sent: 0,
			};
			sendResult(id, result);
			return;
		}

		const runs = await collectSessionRuns(sessionId, maxRuns, log);
		let eventsSent = 0;
		let truncated = false;
		for (const run of runs) {
			for await (const line of readJsonl(run.path)) {
				if (eventsSent >= maxEvents) {
					truncated = true;
					break;
				}
				let record: SessionRecord | null = null;
				try {
					record = JSON.parse(line) as SessionRecord;
				} catch {
					continue;
				}
				if (!record || typeof record !== "object") continue;
				if (record.type === "run.start") {
					const input = runStartInputToHiddenMessage(record.input);
					if (input) {
						sendHistoryEvent(record.run_id, -1, {
							type: "hidden_user_message",
							content: input,
						});
						eventsSent += 1;
					}
					continue;
				}
				if (record.type === "agent.event") {
					sendHistoryEvent(record.run_id, record.seq, record.event);
					eventsSent += 1;
				}
			}
			if (truncated) break;
		}

		const result: SessionHistoryResult = {
			runs: runs.length,
			events_sent: eventsSent,
			...(truncated ? { truncated: true } : {}),
		};
		sendResult(id, result);
	};

	return { handleSessionList, handleSessionHistory };
};
