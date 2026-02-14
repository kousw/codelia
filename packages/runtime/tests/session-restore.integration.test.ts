import { describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
	BaseMessage,
	LlmRequestRecord,
	SessionHeader,
	SessionRecord,
} from "@codelia/core";
import type {
	RpcMessage,
	RpcNotification,
	RpcResponse,
	RunStartResult,
	RunStatusNotify,
	SessionHistoryResult,
} from "@codelia/protocol";
import {
	ensureStorageDirs,
	resolveStoragePaths,
	SessionStateStoreImpl,
} from "@codelia/storage";
import { createAgentFactory } from "../src/agent-factory";
import { createRuntimeHandlers } from "../src/rpc/handlers";
import { RuntimeState } from "../src/runtime-state";
import { integrationTest } from "./test-helpers";

type ProviderName = "openai" | "anthropic";

const TEST_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 500;

const providerTest = (
	name: string,
	envOk: boolean,
	fn: () => Promise<void>,
) => {
	const runner = envOk ? integrationTest : test.skip;
	runner(name, fn, { timeout: TEST_TIMEOUT_MS });
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

const isRpcMessage = (value: unknown): value is RpcMessage =>
	isRecord(value) && value.jsonrpc === "2.0";

const isRpcResponse = (value: unknown): value is RpcResponse =>
	isRpcMessage(value) && "id" in value && !("method" in value);

const isRpcNotification = (value: unknown): value is RpcNotification =>
	isRpcMessage(value) && !("id" in value) && "method" in value;

const isLlmRequestRecord = (
	record: SessionRecord,
): record is LlmRequestRecord => record.type === "llm.request";

const isSessionHeader = (record: SessionRecord): record is SessionHeader =>
	record.type === "header";

const contentToString = (content: BaseMessage["content"]): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if ("text" in part && typeof part.text === "string") return part.text;
			if ("type" in part && part.type === "image_url") return "[image]";
			if ("type" in part && part.type === "document") return "[document]";
			return "";
		})
		.join("");
};

const hasUserMessage = (messages: BaseMessage[], needle: string): boolean =>
	messages.some(
		(msg) =>
			msg.role === "user" &&
			contentToString(msg.content).toLowerCase().includes(needle.toLowerCase()),
	);

const userMessageOrder = (messages: BaseMessage[]): string[] =>
	messages
		.filter((msg) => msg.role === "user")
		.map((msg) => contentToString(msg.content))
		.filter((text) => text.trim().length > 0);

const systemMessageContent = (messages: BaseMessage[]): string | undefined => {
	const found = messages.find((msg) => msg.role === "system");
	if (!found) return undefined;
	return contentToString(found.content);
};

const waitFor = async (
	condition: () => Promise<boolean> | boolean,
	timeoutMs: number,
): Promise<void> => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await condition()) return;
		await Bun.sleep(POLL_INTERVAL_MS);
	}
	throw new Error("Timed out waiting for condition");
};

const waitForSessionState = async (
	store: SessionStateStoreImpl,
	sessionId: string,
	options?: {
		minUpdatedAt?: string;
		minMessages?: number;
		requireMessage?: string;
	},
): Promise<{
	updated_at: string;
	run_id?: string;
	messages: BaseMessage[];
}> => {
	let latest: {
		updated_at: string;
		run_id?: string;
		messages: BaseMessage[];
	} | null = null;
	await waitFor(async () => {
		const parsed = await store.load(sessionId);
		if (!parsed?.updated_at || !Array.isArray(parsed.messages)) return false;
		if (options?.minUpdatedAt) {
			const newer =
				new Date(parsed.updated_at).getTime() >
				new Date(options.minUpdatedAt).getTime();
			if (!newer) return false;
		}
		if (options?.minMessages && parsed.messages.length < options.minMessages) {
			return false;
		}
		if (
			options?.requireMessage &&
			!hasUserMessage(parsed.messages, options.requireMessage)
		) {
			return false;
		}
		latest = parsed;
		return true;
	}, TEST_TIMEOUT_MS);
	if (!latest) {
		throw new Error("Session state was not saved");
	}
	return latest;
};

const findRunFile = async (
	sessionsDir: string,
	runId: string,
): Promise<string> => {
	const glob = new Bun.Glob("**/*.jsonl");
	const matches = await Array.fromAsync(
		glob.scan({ cwd: sessionsDir, onlyFiles: true }),
	);
	const target = matches.find((item) => item.endsWith(`${runId}.jsonl`));
	if (!target) {
		throw new Error(`Run file not found for ${runId}`);
	}
	return path.join(sessionsDir, target);
};

const readJsonl = async (filePath: string): Promise<SessionRecord[]> => {
	const raw = await fs.readFile(filePath, "utf8");
	return raw
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => JSON.parse(line) as SessionRecord);
};

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
					// ignore non-JSON output
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
		async waitForResponse(id: string): Promise<RpcResponse> {
			let result: RpcResponse | undefined;
			await waitFor(() => {
				result = messages.find((msg) => isRpcResponse(msg) && msg.id === id) as
					| RpcResponse
					| undefined;
				return !!result;
			}, TEST_TIMEOUT_MS);
			if (!result) {
				throw new Error(`Response not found for id=${id}`);
			}
			return result;
		},
		async waitForRunStatus(runId: string): Promise<RunStatusNotify> {
			let result: RunStatusNotify | undefined;
			await waitFor(() => {
				const match = messages.find((msg): msg is RpcNotification => {
					if (!isRpcNotification(msg)) return false;
					if (msg.method !== "run.status") return false;
					const params = msg.params as RunStatusNotify | undefined;
					if (!params || params.run_id !== runId) return false;
					if (!params.status) return false;
					return ["completed", "error", "cancelled"].includes(params.status);
				});
				if (match) {
					result = match.params as RunStatusNotify;
				}
				return !!result;
			}, TEST_TIMEOUT_MS);
			if (!result) {
				throw new Error(`run.status not received for run_id=${runId}`);
			}
			return result;
		},
	};
};

const withTempStorageEnv = async (
	provider: ProviderName,
	modelName: string,
) => {
	const tempRoot = await fs.mkdtemp(
		path.join(os.tmpdir(), "codelia-integration-"),
	);
	const envSnapshot = new Map<string, string | undefined>();
	const setEnv = (key: string, value: string) => {
		envSnapshot.set(key, process.env[key]);
		process.env[key] = value;
	};

	setEnv("CODELIA_LAYOUT", "xdg");
	setEnv("XDG_STATE_HOME", path.join(tempRoot, "state"));
	setEnv("XDG_CACHE_HOME", path.join(tempRoot, "cache"));
	setEnv("XDG_CONFIG_HOME", path.join(tempRoot, "config"));
	setEnv("XDG_DATA_HOME", path.join(tempRoot, "data"));

	const paths = resolveStoragePaths();
	await ensureStorageDirs(paths);

	const configPath = path.join(paths.configDir, "config.json");
	setEnv("CODELIA_CONFIG_PATH", configPath);

	const config = {
		version: 1,
		model: {
			provider,
			name: modelName,
		},
	};
	await fs.writeFile(
		configPath,
		`${JSON.stringify(config, null, 2)}\n`,
		"utf8",
	);

	return {
		paths,
		async cleanup() {
			for (const [key, value] of envSnapshot) {
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

const runRestoreScenario = async (
	provider: ProviderName,
	modelName: string,
) => {
	const { paths, cleanup } = await withTempStorageEnv(provider, modelName);
	const sessionStateStore = new SessionStateStoreImpl({ paths });
	const state = new RuntimeState();
	const getAgent = createAgentFactory(state);
	const handlers = createRuntimeHandlers({
		state,
		getAgent,
		log: () => {},
	});
	const capture = createStdoutCapture();
	capture.start();

	try {
		const sessionId = crypto.randomUUID();
		state.sessionId = sessionId;
		const firstPrompt = "Remember this token: alpha-restore";
		const secondPrompt = "Now respond with OK.";

		handlers.processMessage({
			jsonrpc: "2.0",
			id: "run-1",
			method: "run.start",
			params: {
				input: { type: "text", text: firstPrompt },
			},
		});

		const run1Response = await capture.waitForResponse("run-1");
		if (run1Response.error) {
			throw new Error(`run.start failed: ${run1Response.error.message}`);
		}
		const run1Result = run1Response.result as RunStartResult | undefined;
		if (!run1Result?.run_id) {
			throw new Error("run.start did not return run_id");
		}
		const run1Status = await capture.waitForRunStatus(run1Result.run_id);
		if (run1Status.status === "error") {
			throw new Error(`run failed: ${run1Status.message ?? "unknown error"}`);
		}

		const firstState = await waitForSessionState(sessionStateStore, sessionId, {
			requireMessage: firstPrompt,
		});
		expect(hasUserMessage(firstState.messages, firstPrompt)).toBe(true);

		const state2 = new RuntimeState();
		const getAgent2 = createAgentFactory(state2);
		const handlers2 = createRuntimeHandlers({
			state: state2,
			getAgent: getAgent2,
			log: () => {},
		});

		handlers2.processMessage({
			jsonrpc: "2.0",
			id: "run-2",
			method: "run.start",
			params: {
				session_id: sessionId,
				input: { type: "text", text: secondPrompt },
			},
		});

		const run2Response = await capture.waitForResponse("run-2");
		if (run2Response.error) {
			throw new Error(`run.start failed: ${run2Response.error.message}`);
		}
		const run2Result = run2Response.result as RunStartResult | undefined;
		if (!run2Result?.run_id) {
			throw new Error("run.start did not return run_id");
		}
		const run2Status = await capture.waitForRunStatus(run2Result.run_id);
		if (run2Status.status === "error") {
			throw new Error(`run failed: ${run2Status.message ?? "unknown error"}`);
		}

		const secondState = await waitForSessionState(
			sessionStateStore,
			sessionId,
			{
				minUpdatedAt: firstState.updated_at,
				minMessages: firstState.messages.length + 1,
				requireMessage: secondPrompt,
			},
		);
		expect(secondState.run_id).toBeTruthy();
		expect(hasUserMessage(secondState.messages, secondPrompt)).toBe(true);

		if (!secondState.run_id) {
			throw new Error("Expected run_id to be set after second run");
		}
		const runFile = await findRunFile(paths.sessionsDir, secondState.run_id);
		const records = await readJsonl(runFile);
		const header = records.find(isSessionHeader);
		expect(header).toBeTruthy();
		if (header) {
			expect(header.session_id).toBe(sessionId);
			const prompt = header.prompts?.system ?? "";
			expect(prompt.length).toBeGreaterThan(0);
			expect(prompt).toContain("Working directory:");
			expect(header.tools?.definitions?.length ?? 0).toBeGreaterThan(0);
		}

		const request = records.find(isLlmRequestRecord);
		expect(request).toBeTruthy();
		if (!request) {
			throw new Error("Expected llm.request record");
		}
		const inputMessages = request.input.messages as BaseMessage[];
		expect(Array.isArray(inputMessages)).toBe(true);
		expect(hasUserMessage(inputMessages, firstPrompt)).toBe(true);
		const systemContent = systemMessageContent(inputMessages);
		expect(systemContent?.length ?? 0).toBeGreaterThan(0);
		expect(systemContent ?? "").toContain("Working directory:");
		expect((request.input.tools ?? []).length).toBeGreaterThan(0);

		const userTexts = userMessageOrder(inputMessages);
		const firstIndex = userTexts.findIndex((text) =>
			text.toLowerCase().includes(firstPrompt.toLowerCase()),
		);
		const secondIndex = userTexts.findIndex((text) =>
			text.toLowerCase().includes(secondPrompt.toLowerCase()),
		);
		expect(firstIndex).toBeGreaterThanOrEqual(0);
		expect(secondIndex).toBeGreaterThanOrEqual(0);
		expect(firstIndex).toBeLessThan(secondIndex);

		handlers2.processMessage({
			jsonrpc: "2.0",
			id: "history-1",
			method: "session.history",
			params: { session_id: sessionId, max_events: 1 },
		});
		const historyResponse = await capture.waitForResponse("history-1");
		const historyResult = historyResponse.result as
			| SessionHistoryResult
			| undefined;
		expect(historyResult?.events_sent).toBeGreaterThan(0);
		expect(historyResult?.truncated).toBe(true);
	} finally {
		capture.stop();
		await cleanup();
	}
};

describe("runtime session restore (integration)", () => {
	const openaiReady = Boolean(
		process.env.INTEGRATION &&
			process.env.OPENAI_API_KEY &&
			process.env.CODELIA_TEST_OPENAI_MODEL,
	);
	const anthropicReady = Boolean(
		process.env.INTEGRATION &&
			process.env.ANTHROPIC_API_KEY &&
			process.env.CODELIA_TEST_ANTHROPIC_MODEL,
	);

	providerTest(
		"openai: restore reuses prior messages",
		openaiReady,
		async () => {
			const model = process.env.CODELIA_TEST_OPENAI_MODEL;
			if (!model) {
				throw new Error("CODELIA_TEST_OPENAI_MODEL is required");
			}
			await runRestoreScenario("openai", model);
		},
	);

	providerTest(
		"anthropic: restore reuses prior messages",
		anthropicReady,
		async () => {
			const model = process.env.CODELIA_TEST_ANTHROPIC_MODEL;
			if (!model) {
				throw new Error("CODELIA_TEST_ANTHROPIC_MODEL is required");
			}
			await runRestoreScenario("anthropic", model);
		},
	);
});
