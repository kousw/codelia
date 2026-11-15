import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	Agent,
	type BaseChatModel,
	stringifyContent,
	type Tool,
	type ToolContext,
} from "@codelia/core";
import { resolveStoragePaths, SessionStateStoreImpl } from "@codelia/storage";
import { createConversationTools } from "../src/tools/conversation";

const context: ToolContext = { deps: {}, resolve: async (key) => key.create() };
async function invoke(tool: Tool, input: unknown) {
	const result = await tool.executeRaw(JSON.stringify(input), context);
	if (result.type !== "json") throw new Error("Expected a JSON tool result");
	return result.value;
}

test("the agent can search and read an original absent from its compacted context", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "codelia-conversation-tool-"),
	);
	try {
		const store = new SessionStateStoreImpl({
			paths: resolveStoragePaths({ rootOverride: root }),
		});
		await store.appendMessages("session", [
			{
				role: "user",
				content: "Original decision: choose SQLite for Project Alpha.",
			},
		]);
		await store.save({
			schema_version: 1,
			session_id: "session",
			updated_at: new Date().toISOString(),
			messages: [
				{
					role: "user",
					content: "[codelia.compaction.summary]\nA storage decision was made.",
				},
			],
		});
		const saved = await store.load("session");
		if (!saved) throw new Error("missing checkpoint");
		let calls = 0;
		const llm: BaseChatModel = {
			provider: "openai",
			model: "gpt-5",
			ainvoke: async (input) => {
				calls++;
				if (calls === 1) {
					expect(JSON.stringify(input.messages)).not.toContain("choose SQLite");
					return {
						messages: [
							{
								role: "assistant",
								content: null,
								tool_calls: [
									{
										id: "search",
										type: "function",
										function: {
											name: "conversation_search",
											arguments: '{"query":"Project Alpha"}',
										},
									},
								],
							},
						],
					};
				}
				const output = input.messages
					.filter((message) => message.role === "tool")
					.at(-1);
				if (!output) throw new Error("missing retrieval result");
				const result = JSON.parse(stringifyContent(output.content));
				if (calls === 2)
					return {
						messages: [
							{
								role: "assistant",
								content: null,
								tool_calls: [
									{
										id: "read",
										type: "function",
										function: {
											name: "conversation_read",
											arguments: JSON.stringify({ id: result.matches[0].id }),
										},
									},
								],
							},
						],
					};
				expect(result.historical).toBe(true);
				return {
					messages: [{ role: "assistant", content: result.message.text }],
				};
			},
		};
		const agent = new Agent({
			llm,
			tools: createConversationTools(store, () => "session"),
			compaction: null,
		});
		agent.replaceHistoryMessages(saved.messages);
		expect(
			await agent.run("Which database did we choose?", {
				session: {
					run_id: "run",
					append: () => {},
					recordMessages: (messages) =>
						store.appendMessages("session", messages),
				},
			}),
		).toBe("Original decision: choose SQLite for Project Alpha.");
		expect(calls).toBe(3);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("retrieval is current-session-only, bounded, paginated and unavailable without an adapter", async () => {
	expect(createConversationTools(undefined, () => "session")).toEqual([]);
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "codelia-conversation-scope-"),
	);
	try {
		const store = new SessionStateStoreImpl({
			paths: resolveStoragePaths({ rootOverride: root }),
		});
		await store.appendMessages("current", [
			{ role: "user", content: "original ".repeat(10000) },
			{ role: "assistant", content: "another original" },
		]);
		await store.appendMessages("other", [
			{ role: "user", content: "private-other-session" },
		]);
		const [search, read] = createConversationTools(store, () => "current");
		const first = (await invoke(search, { query: "original", limit: 1 })) as {
			matches: Array<{ id: string; text: string }>;
			next_cursor: string;
		};
		expect(first.matches).toHaveLength(1);
		expect(first.matches[0].text.length).toBeLessThanOrEqual(240);
		const second = (await invoke(search, {
			query: "original",
			cursor: first.next_cursor,
		})) as { matches: Array<{ id: string }> };
		expect(second.matches).toHaveLength(1);
		expect(second.matches[0].id).not.toBe(first.matches[0].id);
		const hidden = (await invoke(search, {
			query: "private-other-session",
			session_id: "other",
		})) as { matches: unknown[] };
		expect(hidden.matches).toEqual([]);
		const window = (await invoke(read, {
			id: first.matches[0].id,
			limit: 30,
		})) as { message: { text: string; next_offset: number } };
		expect(window.message.text.length).toBe(30);
		expect(window.message.next_offset).toBe(30);
		await expect(store.readMessage("current", { id: "m1" })).rejects.toThrow(
			"boundary",
		);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});
