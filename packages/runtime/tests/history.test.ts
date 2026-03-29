import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Agent, SessionStateStore } from "@codelia/core";
import type {
	RpcMessage,
	RpcNotification,
	RpcResponse,
} from "@codelia/protocol";
import { ensureStorageDirs, resolveStoragePaths } from "@codelia/storage";
import { createHistoryHandlers } from "../src/rpc/history";
import { createRuntimeHandlers } from "../src/rpc/handlers";
import { RuntimeState } from "../src/runtime-state";

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

const waitForResponse = async (
	capture: ReturnType<typeof createStdoutCapture>,
	id: string,
): Promise<RpcResponse> => {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const response = capture
			.messages()
			.find((msg): msg is RpcResponse => isRpcResponse(msg) && msg.id === id);
		if (response) {
			return response;
		}
		await Bun.sleep(20);
	}
	throw new Error(`Timed out waiting for response ${id}`);
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
	test("session.list defaults to the current workspace and can opt into all sessions", async () => {
		const sessionStateStore: SessionStateStore = {
			load: async () => null,
			save: async () => undefined,
			list: async () => [
				{
					session_id: "same-worktree",
					updated_at: "2026-02-08T00:01:00.000Z",
					workspace_root: "/repo/main",
					last_user_message: "same",
				},
				{
					session_id: "other-worktree",
					updated_at: "2026-02-08T00:02:00.000Z",
					workspace_root: "/repo/lane-a",
					last_user_message: "other",
				},
				{
					session_id: "legacy-unscoped",
					updated_at: "2026-02-08T00:03:00.000Z",
					last_user_message: "legacy",
				},
			],
		};
		const { handleSessionList } = createHistoryHandlers({
			sessionStateStore,
			log: () => {},
			getCurrentWorkspaceRoot: () => "/repo/main",
		});

		const capture = createStdoutCapture();
		capture.start();
		try {
			await handleSessionList("list-current", {});
			await handleSessionList("list-all", { scope: "all" });
		} finally {
			capture.stop();
		}

		const responses = capture
			.messages()
			.filter((msg): msg is RpcResponse => isRpcResponse(msg));
		const currentWorkspace = responses.find((msg) => msg.id === "list-current");
		expect(currentWorkspace).toBeTruthy();
		expect(currentWorkspace?.result).toEqual({
			current_workspace_root: "/repo/main",
			sessions: [
				{
					session_id: "same-worktree",
					updated_at: "2026-02-08T00:01:00.000Z",
					workspace_root: "/repo/main",
					last_user_message: "same",
				},
			],
		});

		const allSessions = responses.find((msg) => msg.id === "list-all");
		expect(allSessions).toBeTruthy();
		expect(allSessions?.result).toEqual({
			current_workspace_root: undefined,
			sessions: [
				{
					session_id: "legacy-unscoped",
					updated_at: "2026-02-08T00:03:00.000Z",
					last_user_message: "legacy",
				},
				{
					session_id: "other-worktree",
					updated_at: "2026-02-08T00:02:00.000Z",
					workspace_root: "/repo/lane-a",
					last_user_message: "other",
				},
				{
					session_id: "same-worktree",
					updated_at: "2026-02-08T00:01:00.000Z",
					workspace_root: "/repo/main",
					last_user_message: "same",
				},
			],
		});
	});

	test("session.history includes resume_diff when provided by runtime context comparer", async () => {
		const { paths, cleanup } = await withTempStorageEnv();
		try {
			const sessionId = "session-with-resume-diff";
			const runId = "run-with-resume-diff";
			const startedAt = "2026-02-08T00:00:00.000Z";
			const runDir = path.join(paths.sessionsDir, "2026", "02", "08");
			const runPath = path.join(runDir, `${runId}.jsonl`);
			await fs.mkdir(runDir, { recursive: true });
			await fs.writeFile(
				runPath,
				[
					JSON.stringify({
						type: "header",
						schema_version: 1,
						run_id: runId,
						session_id: sessionId,
						started_at: startedAt,
					}),
					JSON.stringify({
						type: "run.start",
						run_id: runId,
						session_id: sessionId,
						ts: startedAt,
						input: { type: "text", text: "resume me" },
					}),
				].join("\n") + "\n",
				"utf8",
			);

			const sessionStateStore: SessionStateStore = {
				load: async () => ({
					schema_version: 1,
					session_id: sessionId,
					updated_at: startedAt,
					run_id: runId,
					messages: [],
					meta: { codelia_workspace_root: "/repo/main" },
				}),
				save: async () => undefined,
				list: async () => [],
			};
			const { handleSessionHistory } = createHistoryHandlers({
				sessionStateStore,
				log: () => {},
				buildResumeDiffSummary: async () =>
					"Resume context:\n- Current workspace root: /repo/main",
			});

			const capture = createStdoutCapture();
			capture.start();
			try {
				await handleSessionHistory("history-resume-diff", {
					session_id: sessionId,
					max_runs: 10,
					max_events: 10,
				});
			} finally {
				capture.stop();
			}

			const response = capture
				.messages()
				.find(
					(msg): msg is RpcResponse =>
						isRpcResponse(msg) && msg.id === "history-resume-diff",
				);
			expect(response?.result).toEqual({
				runs: 1,
				events_sent: 1,
				resume_diff: "Resume context:\n- Current workspace root: /repo/main",
			});
		} finally {
			await cleanup();
		}
	});

	test("runtime handlers build session.history resume_diff from already-known current context", async () => {
		const { cleanup } = await withTempStorageEnv();
		try {
			const state = new RuntimeState();
			const sessionId = "session-hydrated-resume-diff";
			const startedAt = "2026-02-08T00:00:00.000Z";
			let getAgentCalls = 0;
			state.lastUiContext = { workspace_root: "/repo/main", cwd: "/repo/main" };
			state.runtimeWorkingDir = "/repo/main";
			state.runtimeSandboxRoot = "/repo/main";
			state.approvalMode = "trusted";
			state.currentModelProvider = "openai";
			state.currentModelName = "gpt-test";
			state.agentsResolver = {
				getRootDir: () => "/repo/main",
				getSnapshot: () => ({ initialFiles: [] }),
			} as never;
			state.skillsResolver = {
				getSnapshot: () => ({ loaded_versions: [] }),
			} as never;
			const sessionStateStore: SessionStateStore = {
				load: async () => ({
					schema_version: 1,
					session_id: sessionId,
					updated_at: startedAt,
					messages: [],
					meta: {
						codelia_resume_context: {
							schema_version: 1,
							workspace_root: "/repo/main",
							working_dir: "/repo/main",
							sandbox_root: "/repo/main",
							approval_mode: "minimal",
							model_provider: "openai",
							model_name: "gpt-test",
							initial_agents: [],
							loaded_skills: [],
						},
					},
				}),
				save: async () => undefined,
				list: async () => [
					{
						session_id: sessionId,
						updated_at: startedAt,
						workspace_root: "/repo/main",
					},
				],
			};
			const handlers = createRuntimeHandlers({
				state,
				getAgent: async () => {
					getAgentCalls += 1;
					throw new Error("session.history should not require getAgent");
				},
				log: () => {},
				sessionStateStore,
			});

			const capture = createStdoutCapture();
			capture.start();
			try {
				handlers.processMessage({
					jsonrpc: "2.0",
					id: "history-hydrated-resume-diff",
					method: "session.history",
					params: {
						session_id: sessionId,
						max_runs: 1,
						max_events: 1,
					},
				});
				const response = await waitForResponse(
					capture,
					"history-hydrated-resume-diff",
				);
				expect(getAgentCalls).toBe(0);
				expect((response.result as { resume_diff?: string }).resume_diff).toContain(
					"Approval mode changed: minimal -> trusted",
				);
				expect((response.result as { resume_diff?: string }).resume_diff).not.toContain(
					"(unknown)",
				);
			} finally {
				capture.stop();
			}
		} finally {
			await cleanup();
		}
	});

	test("runtime handlers suppress no-op session.history resume_diff", async () => {
		const { cleanup } = await withTempStorageEnv();
		try {
			const state = new RuntimeState();
			const sessionId = "session-noop-resume-diff";
			const startedAt = "2026-02-08T00:00:00.000Z";
			let getAgentCalls = 0;
			state.lastUiContext = { workspace_root: "/repo/main", cwd: "/repo/main" };
			state.runtimeWorkingDir = "/repo/main";
			state.runtimeSandboxRoot = "/repo/main";
			state.approvalMode = "trusted";
			state.currentModelProvider = "openai";
			state.currentModelName = "gpt-test";
			state.agentsResolver = {
				getRootDir: () => "/repo/main",
				getSnapshot: () => ({ initialFiles: [] }),
			} as never;
			state.skillsResolver = {
				getSnapshot: () => ({ loaded_versions: [] }),
			} as never;
			const sessionStateStore: SessionStateStore = {
				load: async () => ({
					schema_version: 1,
					session_id: sessionId,
					updated_at: startedAt,
					messages: [],
					meta: {
						codelia_resume_context: {
							schema_version: 1,
							workspace_root: "/repo/main",
							working_dir: "/repo/main",
							sandbox_root: "/repo/main",
							approval_mode: "trusted",
							model_provider: "openai",
							model_name: "gpt-test",
							initial_agents: [],
							loaded_skills: [],
						},
					},
				}),
				save: async () => undefined,
				list: async () => [
					{
						session_id: sessionId,
						updated_at: startedAt,
						workspace_root: "/repo/main",
					},
				],
			};
			const handlers = createRuntimeHandlers({
				state,
				getAgent: async () => {
					getAgentCalls += 1;
					throw new Error("session.history should not require getAgent");
				},
				log: () => {},
				sessionStateStore,
			});

			const capture = createStdoutCapture();
			capture.start();
			try {
				handlers.processMessage({
					jsonrpc: "2.0",
					id: "history-noop-resume-diff",
					method: "session.history",
					params: {
						session_id: sessionId,
						max_runs: 1,
						max_events: 1,
					},
				});
				const response = await waitForResponse(capture, "history-noop-resume-diff");
				expect(getAgentCalls).toBe(0);
				expect(response.result).toEqual({ runs: 0, events_sent: 0 });
			} finally {
				capture.stop();
			}
		} finally {
			await cleanup();
		}
	});

	test("runtime handlers ignore unknown current approval mode in best-effort session.history diff", async () => {
		const { cleanup } = await withTempStorageEnv();
		try {
			const state = new RuntimeState();
			const sessionId = "session-unknown-approval-resume-diff";
			const startedAt = "2026-02-08T00:00:00.000Z";
			state.lastUiContext = { workspace_root: "/repo/main", cwd: "/repo/main" };
			state.runtimeWorkingDir = "/repo/main";
			state.runtimeSandboxRoot = "/repo/main";
			state.agentsResolver = {
				getRootDir: () => "/repo/main",
				getSnapshot: () => ({ initialFiles: [] }),
			} as never;
			state.skillsResolver = {
				getSnapshot: () => ({ loaded_versions: [] }),
			} as never;
			const sessionStateStore: SessionStateStore = {
				load: async () => ({
					schema_version: 1,
					session_id: sessionId,
					updated_at: startedAt,
					messages: [],
					meta: {
						codelia_resume_context: {
							schema_version: 1,
							workspace_root: "/repo/main",
							working_dir: "/repo/main",
							sandbox_root: "/repo/main",
							approval_mode: "trusted",
							initial_agents: [],
							loaded_skills: [],
						},
					},
				}),
				save: async () => undefined,
				list: async () => [
					{
						session_id: sessionId,
						updated_at: startedAt,
						workspace_root: "/repo/main",
					},
				],
			};
			const handlers = createRuntimeHandlers({
				state,
				getAgent: async () => {
					throw new Error("session.history should not require getAgent");
				},
				log: () => {},
				sessionStateStore,
			});

			const capture = createStdoutCapture();
			capture.start();
			try {
				handlers.processMessage({
					jsonrpc: "2.0",
					id: "history-unknown-approval-resume-diff",
					method: "session.history",
					params: {
						session_id: sessionId,
						max_runs: 1,
						max_events: 1,
					},
				});
				const response = await waitForResponse(
					capture,
					"history-unknown-approval-resume-diff",
				);
				expect(response.result).toEqual({ runs: 0, events_sent: 0 });
			} finally {
				capture.stop();
			}
		} finally {
			await cleanup();
		}
	});

	test("runtime handlers suppress legacy session.history resume_diff", async () => {
		const { cleanup } = await withTempStorageEnv();
		try {
			const state = new RuntimeState();
			const sessionId = "session-legacy-resume-diff";
			const startedAt = "2026-02-08T00:00:00.000Z";
			let getAgentCalls = 0;
			const sessionStateStore: SessionStateStore = {
				load: async () => ({
					schema_version: 1,
					session_id: sessionId,
					updated_at: startedAt,
					messages: [],
					meta: { codelia_workspace_root: "/repo/main" },
				}),
				save: async () => undefined,
				list: async () => [
					{
						session_id: sessionId,
						updated_at: startedAt,
						workspace_root: "/repo/main",
					},
				],
			};
			const handlers = createRuntimeHandlers({
				state,
				getAgent: async () => {
					getAgentCalls += 1;
					throw new Error("legacy session.history should not hydrate current context");
				},
				log: () => {},
				sessionStateStore,
			});

			const capture = createStdoutCapture();
			capture.start();
			try {
				handlers.processMessage({
					jsonrpc: "2.0",
					id: "history-legacy-resume-diff",
					method: "session.history",
					params: {
						session_id: sessionId,
						max_runs: 1,
						max_events: 1,
					},
				});
				const response = await waitForResponse(capture, "history-legacy-resume-diff");
				expect(getAgentCalls).toBe(0);
				expect(response.result).toEqual({ runs: 0, events_sent: 0 });
			} finally {
				capture.stop();
			}
		} finally {
			await cleanup();
		}
	});

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

	test("keeps the latest max_events across selected runs when truncated", async () => {
		const { paths, cleanup } = await withTempStorageEnv();
		try {
			const sessionId = "session-tail-events";
			const runDir = path.join(paths.sessionsDir, "2026", "02", "08");
			await fs.mkdir(runDir, { recursive: true });

			const writeRun = async (
				runId: string,
				startedAt: string,
				inputText: string,
				finalText: string,
			): Promise<void> => {
				const runPath = path.join(runDir, `${runId}.jsonl`);
				const header = {
					type: "header",
					schema_version: 1,
					run_id: runId,
					session_id: sessionId,
					started_at: startedAt,
					prompts: { system: "test" },
				};
				const runStart = {
					type: "run.start",
					run_id: runId,
					session_id: sessionId,
					ts: startedAt,
					input: { type: "text", text: inputText },
				};
				const event = {
					type: "agent.event",
					run_id: runId,
					seq: 0,
					ts: startedAt,
					event: { type: "final", text: finalText },
				};
				await fs.writeFile(
					runPath,
					`${JSON.stringify(header)}\n${JSON.stringify(runStart)}\n${JSON.stringify(event)}\n`,
					"utf8",
				);
			};

			await writeRun(
				"run-old",
				"2026-02-08T00:00:00.000Z",
				"old input",
				"old final",
			);
			await writeRun(
				"run-new",
				"2026-02-08T00:01:00.000Z",
				"new input",
				"new final",
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
				await handleSessionHistory("history-tail", {
					session_id: sessionId,
					max_runs: 10,
					max_events: 2,
				});
			} finally {
				capture.stop();
			}

			const messages = capture.messages();
			const response = messages.find(
				(msg): msg is RpcResponse =>
					isRpcResponse(msg) && msg.id === "history-tail",
			);
			expect(response).toBeTruthy();
			const result = response?.result as
				| { runs: number; events_sent: number; truncated?: boolean }
				| undefined;
			expect(result?.runs).toBe(2);
			expect(result?.events_sent).toBe(2);
			expect(result?.truncated).toBe(true);

			const events = messages.filter(
				(msg): msg is RpcNotification =>
					isRpcNotification(msg) && msg.method === "agent.event",
			);
			expect(events).toHaveLength(2);
			expect(
				(
					events[0]?.params as {
						run_id?: string;
						event?: { type?: string; content?: string };
					}
				).run_id,
			).toBe("run-new");
			expect(
				(events[0]?.params as { event?: { type?: string; content?: string } })
					.event,
			).toEqual({ type: "hidden_user_message", content: "new input" });
			expect(
				(
					events[1]?.params as {
						run_id?: string;
						event?: { type?: string; text?: string };
					}
				).run_id,
			).toBe("run-new");
			expect(
				(events[1]?.params as { event?: { type?: string; text?: string } })
					.event,
			).toEqual({ type: "final", text: "new final" });
		} finally {
			await cleanup();
		}
	});

	test("restores hidden user message for run.start parts input", async () => {
		const { paths, cleanup } = await withTempStorageEnv();
		try {
			const sessionId = "session-parts-input";
			const runId = "run-parts-input";
			const startedAt = "2026-02-08T00:00:00.000Z";
			const runDir = path.join(paths.sessionsDir, "2026", "02", "08");
			const runPath = path.join(runDir, `${runId}.jsonl`);
			await fs.mkdir(runDir, { recursive: true });

			const header = {
				type: "header",
				schema_version: 1,
				run_id: runId,
				session_id: sessionId,
				started_at: startedAt,
				prompts: { system: "test" },
			};
			const runStart = {
				type: "run.start",
				run_id: runId,
				session_id: sessionId,
				ts: startedAt,
				input: {
					type: "parts",
					parts: [
						{ type: "text", text: "check this " },
						{
							type: "image_url",
							image_url: { url: "data:image/png;base64,AAAA" },
						},
						{ type: "text", text: " please" },
					],
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
				await handleSessionHistory("history-parts", {
					session_id: sessionId,
					max_runs: 10,
					max_events: 10,
				});
			} finally {
				capture.stop();
			}

			const hiddenMessageEvent = capture
				.messages()
				.filter(
					(msg): msg is RpcNotification =>
						isRpcNotification(msg) && msg.method === "agent.event",
				)
				.find(
					(msg) =>
						(msg.params as { event?: { type?: string } })?.event?.type ===
						"hidden_user_message",
				);
			expect(hiddenMessageEvent).toBeTruthy();
			expect(
				(hiddenMessageEvent?.params as { event?: { content?: string } }).event
					?.content,
			).toBe("check this [image] please");
		} finally {
			await cleanup();
		}
	});
});
