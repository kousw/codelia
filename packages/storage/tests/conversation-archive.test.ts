import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	Agent,
	type BaseChatModel,
	type BaseMessage,
	type Tool,
} from "@codelia/core";
import { SessionStateStoreImpl, resolveStoragePaths } from "../src";

test("originals survive repeated real compaction, checkpoint reload and bounded retrieval", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "codelia-originals-"));
	try {
		const paths = resolveStoragePaths({ rootOverride: root });
		const store = new SessionStateStoreImpl({ paths });
		const llm: BaseChatModel = {
			provider: "openai",
			model: "gpt-5",
			ainvoke: async () => ({
				messages: [
					{
						role: "assistant",
						content: "<summary>Current work summary</summary>",
					},
				],
			}),
		};
		const agent = new Agent({
			llm,
			tools: [],
			compaction: { auto: false, retainLastTurns: 0 },
			toolOutputCache: null,
		});
		const session = {
			run_id: "run",
			session_id: "session",
			append: () => {},
			recordMessages: async (messages: BaseMessage[]) =>
				store.appendMessages("session", messages),
		};
		const save = () =>
			store.save({
				schema_version: 1,
				session_id: "session",
				updated_at: new Date().toISOString(),
				messages: agent.getHistoryMessages(),
			});
		await agent.run(
			"Original exact decision: use SQLite, not Redis. " +
				"long detail ".repeat(1000),
			{ session },
		);
		await save();
		const file = path.join(paths.sessionsDir, "messages", "session.jsonl");
		const original = await fs.readFile(file);
		for await (const _ of agent.runStream("ignored", {
			session,
			forceCompaction: true,
		})) {
		}
		await save();
		expect(await fs.readFile(file)).toEqual(original);
		expect(
			JSON.stringify((await store.load("session"))?.messages),
		).not.toContain("Original exact decision");
		await agent.run("A second original decision: keep originals.", { session });
		await save();
		for await (const _ of agent.runStream("ignored", {
			session,
			forceCompaction: true,
		})) {
		}
		await save();
		const reopened = new SessionStateStoreImpl({ paths });
		expect(
			JSON.stringify((await reopened.load("session"))?.messages),
		).not.toContain("A second original decision");
		const search = await reopened.searchMessages("session", {
			query: "SQLite",
			limit: 1,
		});
		expect(search.matches).toHaveLength(1);
		const first = await reopened.readMessage("session", {
			id: search.matches[0].id,
			limit: 100,
		});
		expect(first?.text).toContain("Original exact decision");
		expect(first?.text.length).toBe(100);
		expect(first?.next_offset).toBe(100);
		const next = await reopened.readMessage("session", {
			id: search.matches[0].id,
			offset: 100,
			limit: 100,
		});
		expect(next?.text.length).toBe(100);
		expect(
			(await reopened.searchMessages("session", { query: "second original" }))
				.matches,
		).toHaveLength(1);
		expect((await fs.readFile(file)).subarray(0, original.length)).toEqual(
			original,
		);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("legacy migration retains bytes, lifecycle flags and active context separately", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "codelia-originals-migrate-"),
	);
	try {
		const paths = resolveStoragePaths({ rootOverride: root });
		const store = new SessionStateStoreImpl({ paths });
		await store.list();
		const { Database } = await import("bun:sqlite");
		const db = new Database(path.join(paths.sessionsDir, "state.db"));
		db.query(
			"INSERT INTO session_state (session_id,updated_at,schema_version,pinned,archived_at) VALUES (?, ?, 1, 1, ?)",
		).run("legacy", "2026-01-01", "2026-02-01");
		db.close();
		const file = path.join(paths.sessionsDir, "messages", "legacy.jsonl");
		const original = '{"role":"user","content":"legacy original"}\n';
		await fs.writeFile(file, original);
		await store.appendMessages("legacy", [
			{ role: "assistant", content: "new original" },
		]);
		expect((await fs.readFile(file, "utf8")).startsWith(original)).toBe(true);
		expect((await store.load("legacy"))?.messages).toEqual([
			{ role: "user", content: "legacy original" },
		]);
		expect((await store.getSummary("legacy"))?.pinned).toBe(true);
		expect((await store.getSummary("legacy"))?.archived_at).toBe("2026-02-01");
		expect(
			(await store.searchMessages("legacy", { query: "new original" })).matches,
		).toHaveLength(1);
		await fs.appendFile(file, '{"role":');
		const damaged = await fs.readFile(file);
		await expect(
			store.appendMessages("legacy", [
				{ role: "user", content: "must not corrupt" },
			]),
		).rejects.toThrow("Incomplete conversation archive");
		expect(await fs.readFile(file)).toEqual(damaged);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("failed original admission prevents model work and compaction", async () => {
	let calls = 0;
	const agent = new Agent({
		tools: [],
		llm: {
			provider: "openai",
			model: "gpt-5",
			ainvoke: async () => {
				calls++;
				return { messages: [] };
			},
		},
	});
	await expect(
		agent.run("do not lose me", {
			session: {
				run_id: "run",
				append: () => {},
				recordMessages: async () => {
					throw new Error("disk unavailable");
				},
			},
		}),
	).rejects.toThrow("Could not persist original conversation");
	expect(calls).toBe(0);
	expect(agent.getHistoryMessages()).toEqual([]);
});

test("tool originals are archived before cache trimming changes model history", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "codelia-tool-original-"),
	);
	try {
		const store = new SessionStateStoreImpl({
			paths: resolveStoragePaths({ rootOverride: root }),
		});
		const original = `Unique complete tool result\n${"detail\n".repeat(1000)}original ending`;
		let calls = 0;
		const llm: BaseChatModel = {
			provider: "openai",
			model: "gpt-5",
			ainvoke: async () =>
				++calls === 1
					? {
							messages: [
								{
									role: "assistant",
									content: null,
									tool_calls: [
										{
											id: "call",
											type: "function",
											function: { name: "lookup", arguments: "{}" },
										},
									],
								},
							],
						}
					: { messages: [{ role: "assistant", content: "Done" }] },
		};
		const tool: Tool = {
			name: "lookup",
			description: "fixture",
			definition: {
				name: "lookup",
				description: "fixture",
				parameters: { type: "object" },
			},
			executeRaw: async () => ({ type: "text", text: original }),
		};
		const agent = new Agent({
			llm,
			tools: [tool],
			compaction: null,
			toolOutputCache: { maxMessageBytes: 100 },
		});
		await agent.run("Run lookup", {
			session: {
				run_id: "run",
				append: () => {},
				recordMessages: (messages) => store.appendMessages("session", messages),
			},
		});
		expect(JSON.stringify(agent.getHistoryMessages())).not.toContain(
			"original ending",
		);
		const results = await store.searchMessages("session", {
			query: "original ending",
		});
		expect(results.matches).toHaveLength(1);
		const message = await store.readMessage("session", {
			id: results.matches[0].id,
			limit: 8000,
		});
		expect(message?.role).toBe("tool");
		expect(message?.text).toBe(original);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("stable byte IDs handle UTF-8 and CRLF originals without rewriting them", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "codelia-original-crlf-"),
	);
	try {
		const paths = resolveStoragePaths({ rootOverride: root });
		const store = new SessionStateStoreImpl({ paths });
		await store.list();
		const file = path.join(paths.sessionsDir, "messages", "session.jsonl");
		const first = `${JSON.stringify({ role: "user", content: "日本語の原文" })}\r\n`;
		const original = `${first}${JSON.stringify({ role: "assistant", content: "second original" })}\r\n`;
		await fs.writeFile(file, original);
		await store.appendMessages("session", [
			{ role: "user", content: "new original" },
		]);
		const match = await store.searchMessages("session", {
			query: "second original",
		});
		expect(match.matches[0].id).toBe(`m${Buffer.byteLength(first)}`);
		expect(
			(await store.readMessage("session", { id: match.matches[0].id }))?.text,
		).toBe("second original");
		expect((await fs.readFile(file, "utf8")).startsWith(original)).toBe(true);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("refusal-only assistant originals remain searchable and readable", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "codelia-original-refusal-"),
	);
	try {
		const store = new SessionStateStoreImpl({
			paths: resolveStoragePaths({ rootOverride: root }),
		});
		await store.appendMessages("session", [
			{
				role: "assistant",
				content: null,
				refusal: "Original refusal: this operation was rejected.",
			},
		]);
		const matches = await store.searchMessages("session", {
			query: "operation was rejected",
		});
		expect(matches.matches).toHaveLength(1);
		expect(
			(await store.readMessage("session", { id: matches.matches[0].id }))?.text,
		).toBe("Original refusal: this operation was rejected.");
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("failed legacy checkpoint migration propagates and a later append retains available originals", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "codelia-legacy-retry-"),
	);
	try {
		const paths = resolveStoragePaths({ rootOverride: root });
		const store = new SessionStateStoreImpl({ paths });
		await store.list();
		const legacy = {
			schema_version: 1 as const,
			session_id: "legacy",
			updated_at: "2026-01-01",
			messages: [
				{ role: "user" as const, content: "available legacy original" },
			],
			meta: { custom: "preserve legacy metadata" },
		};
		const source = path.join(paths.sessionsDir, "state", "legacy.json");
		await fs.writeFile(source, JSON.stringify(legacy));
		const blocked = path.join(paths.sessionsDir, "contexts", "legacy.json");
		await fs.mkdir(blocked);
		await expect(store.load("legacy")).rejects.toThrow();
		await fs.rm(blocked, { recursive: true });
		await store.appendMessages("legacy", [
			{ role: "assistant", content: "new original after recovery" },
		]);
		await store.save({
			...legacy,
			messages: [
				{
					role: "user",
					content: "[codelia.compaction.summary] Current summary",
				},
			],
		});
		expect(
			(
				await store.searchMessages("legacy", {
					query: "available legacy original",
				})
			).matches,
		).toHaveLength(1);
		expect(
			(
				await store.searchMessages("legacy", {
					query: "new original after recovery",
				})
			).matches,
		).toHaveLength(1);
		expect((await store.load("legacy"))?.meta).toEqual(legacy.meta);
		expect(JSON.parse(await fs.readFile(source, "utf8"))).toEqual(legacy);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("max-step final response cannot hide an original persistence failure behind fallback success", async () => {
	let calls = 0;
	const final = "Final max-step answer";
	const llm: BaseChatModel = {
		provider: "openai",
		model: "gpt-5",
		ainvoke: async () =>
			++calls === 1
				? {
						messages: [
							{
								role: "assistant",
								content: null,
								tool_calls: [
									{
										id: "call",
										type: "function",
										function: { name: "lookup", arguments: "{}" },
									},
								],
							},
						],
					}
				: { messages: [{ role: "assistant", content: final }] },
	};
	const tool: Tool = {
		name: "lookup",
		description: "fixture",
		definition: {
			name: "lookup",
			description: "fixture",
			parameters: { type: "object" },
		},
		executeRaw: async () => ({ type: "text", text: "tool result" }),
	};
	const agent = new Agent({
		llm,
		tools: [tool],
		maxIterations: 1,
		compaction: null,
	});
	await expect(
		agent.run("continue", {
			session: {
				run_id: "run",
				append: () => {},
				recordMessages: async (messages) => {
					if (
						messages.some(
							(message) =>
								message.role === "assistant" && message.content === final,
						)
					)
						throw new Error("disk unavailable");
				},
			},
		}),
	).rejects.toThrow("Could not persist original conversation");
	expect(calls).toBe(2);
});
