import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionStateStore } from "@codelia/core";
import type {
	RpcMessage,
	RpcNotification,
	RpcResponse,
} from "@codelia/protocol";
import { ensureStorageDirs, resolveStoragePaths } from "@codelia/storage";
import { createHistoryHandlers } from "../src/rpc/history";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

const isRpcMessage = (value: unknown): value is RpcMessage =>
	isRecord(value) && value.jsonrpc === "2.0";

const isRpcResponse = (value: RpcMessage): value is RpcResponse =>
	"id" in value && !Object.hasOwn(value, "method");

const isRpcNotification = (value: RpcMessage): value is RpcNotification =>
	!Object.hasOwn(value, "id") && Object.hasOwn(value, "method");

const createStdoutCapture = () => {
	const originalWrite = process.stdout.write.bind(process.stdout);
	let buffer = "";
	const messages: RpcMessage[] = [];

	const write = (chunk: string | Uint8Array): boolean => {
		const text =
			typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		buffer += text;
		let idx = buffer.indexOf("\n");
		while (idx >= 0) {
			const line = buffer.slice(0, idx).trim();
			buffer = buffer.slice(idx + 1);
			if (line) {
				try {
					const parsed = JSON.parse(line) as unknown;
					if (isRpcMessage(parsed)) {
						messages.push(parsed);
					}
				} catch {
					// ignore non-JSON line
				}
			}
			idx = buffer.indexOf("\n");
		}
		return true;
	};

	return {
		start() {
			process.stdout.write = write;
		},
		stop() {
			process.stdout.write = originalWrite;
		},
		messages(): RpcMessage[] {
			return messages.slice();
		},
	};
};

const withTempStorageEnv = async () => {
	const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codelia-history-"));
	const snapshot = new Map<string, string | undefined>();
	const setEnv = (key: string, value: string) => {
		snapshot.set(key, process.env[key]);
		process.env[key] = value;
	};

	setEnv("CODELIA_LAYOUT", "xdg");
	setEnv("XDG_STATE_HOME", path.join(tempRoot, "state"));
	setEnv("XDG_CACHE_HOME", path.join(tempRoot, "cache"));
	setEnv("XDG_CONFIG_HOME", path.join(tempRoot, "config"));

	const paths = resolveStoragePaths();
	await ensureStorageDirs(paths);

	return {
		paths,
		async cleanup() {
			for (const [key, value] of snapshot) {
				if (value === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = value;
				}
			}
			await fs.rm(tempRoot, { recursive: true, force: true });
		},
	};
};

describe("session.history", () => {
	test("collects runs even when header line is larger than 64KB", async () => {
		const { paths, cleanup } = await withTempStorageEnv();
		try {
			const sessionId = "session-large-header";
			const runId = "run-large-header";
			const startedAt = "2026-02-08T00:00:00.000Z";
			const runDir = path.join(paths.sessionsDir, "2026", "02", "08");
			const runPath = path.join(runDir, `${runId}.jsonl`);
			await fs.mkdir(runDir, { recursive: true });

			const largeSystemPrompt = "x".repeat(70_000);
			const header = {
				type: "header",
				schema_version: 1,
				run_id: runId,
				session_id: sessionId,
				started_at: startedAt,
				prompts: { system: largeSystemPrompt },
			};
			const runStart = {
				type: "run.start",
				run_id: runId,
				session_id: sessionId,
				ts: startedAt,
				input: {
					type: "text",
					text: "restore me",
				},
			};
			await fs.writeFile(
				runPath,
				`${JSON.stringify(header)}\n${JSON.stringify(runStart)}\n`,
				"utf8",
			);

			const sessionStateStore: SessionStateStore = {
				load: async () => null,
				save: async () => undefined,
				list: async () => [],
			};
			const { handleSessionHistory } = createHistoryHandlers({
				sessionStateStore,
				log: () => {},
			});

			const capture = createStdoutCapture();
			capture.start();
			try {
				await handleSessionHistory("history-1", {
					session_id: sessionId,
					max_runs: 10,
					max_events: 10,
				});
			} finally {
				capture.stop();
			}

			const messages = capture.messages();
			const response = messages.find(
				(msg): msg is RpcResponse =>
					isRpcResponse(msg) && msg.id === "history-1",
			);
			expect(response).toBeTruthy();
			const result = response?.result as
				| { runs: number; events_sent: number; truncated?: boolean }
				| undefined;
			expect(result?.runs).toBe(1);
			expect(result?.events_sent).toBeGreaterThan(0);
			expect(result?.truncated).toBeUndefined();

			const events = messages.filter(
				(msg): msg is RpcNotification =>
					isRpcNotification(msg) && msg.method === "agent.event",
			);
			expect(events.length).toBeGreaterThan(0);
		} finally {
			await cleanup();
		}
	});
});
