import { beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DependencyKey, ToolContext } from "@codelia/core";
import { createSandboxKey, SandboxContext } from "../src/sandbox/context";
import { createTodoReadTool } from "../src/tools/todo-read";
import { createToolSessionContextKey } from "../src/tools/session-context";
import {
	mergeTodosIntoSessionMeta,
	readTodosFromSessionMeta,
	todoStore,
	TODO_SESSION_META_KEY,
} from "../src/tools/todo-store";
import { createTodoWriteTool } from "../src/tools/todo-write";

const createTempDir = async (): Promise<string> =>
	fs.mkdtemp(path.join(os.tmpdir(), "codelia-todo-tool-"));

const createToolContext = (): ToolContext => {
	const cache = new Map<string, unknown>();
	const deps: Record<string, unknown> = Object.create(null);
	return {
		deps,
		resolve: async <T>(key: DependencyKey<T>): Promise<T> => {
			if (cache.has(key.id)) {
				return cache.get(key.id) as T;
			}
			const value = await key.create();
			cache.set(key.id, value);
			return value;
		},
	};
};

const expectTextResult = (result: unknown): string => {
	if (
		typeof result !== "object" ||
		result === null ||
		!("type" in result) ||
		(result as { type: string }).type !== "text"
	) {
		throw new Error("unexpected tool result");
	}
	const text = (result as { text?: unknown }).text;
	expect(typeof text).toBe("string");
	if (typeof text !== "string") throw new Error("unexpected tool result");
	return text;
};

const schemaAllowsNull = (schema: unknown): boolean => {
	if (!schema || typeof schema !== "object") return false;
	const node = schema as Record<string, unknown>;
	const type = node.type;
	if (type === "null") return true;
	if (Array.isArray(type) && type.includes("null")) return true;
	const unions = [
		...(Array.isArray(node.anyOf) ? node.anyOf : []),
		...(Array.isArray(node.oneOf) ? node.oneOf : []),
	];
	return unions.some((entry) => schemaAllowsNull(entry));
};

describe("todo tools", () => {
	beforeEach(() => {
		todoStore.clear();
	});

	test("todo_write schema has object root for provider strict validation", async () => {
		const tempRoot = await createTempDir();
			try {
				const sandbox = await SandboxContext.create(tempRoot);
				const sandboxKey = createSandboxKey(sandbox);
				const writeTool = createTodoWriteTool(sandboxKey);
				const definition = writeTool.definition;
				if (definition.type === "hosted_search") {
					throw new Error("expected function tool definition");
				}
				expect(definition.parameters.type).toBe("object");
				const top = definition.parameters as Record<string, unknown>;
				expect(top.anyOf).toBeUndefined();
				expect(top.oneOf).toBeUndefined();
				expect(top.allOf).toBeUndefined();
				expect(top.enum).toBeUndefined();
				expect(top.not).toBeUndefined();
			} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("todo_write patch schema keeps nullable no-change sentinels", async () => {
		const tempRoot = await createTempDir();
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const sandboxKey = createSandboxKey(sandbox);
			const writeTool = createTodoWriteTool(sandboxKey);
			const definition = writeTool.definition;
			if (definition.type === "hosted_search") {
				throw new Error("expected function tool definition");
			}
			const params = definition.parameters as Record<string, unknown>;
			const updatesSchema = (params.properties as Record<string, unknown>)
				.updates as Record<string, unknown>;
			const updateItemSchema = updatesSchema.items as Record<string, unknown>;
			const updateProps = updateItemSchema.properties as Record<string, unknown>;
			const required = updateItemSchema.required as string[];

			expect(required).toEqual(
				expect.arrayContaining([
					"content",
					"status",
					"priority",
					"notes",
					"activeForm",
				]),
			);
			expect(schemaAllowsNull(updateProps.content)).toBe(true);
			expect(schemaAllowsNull(updateProps.status)).toBe(true);
			expect(schemaAllowsNull(updateProps.priority)).toBe(true);
			expect(schemaAllowsNull(updateProps.notes)).toBe(true);
			expect(schemaAllowsNull(updateProps.activeForm)).toBe(true);
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("todo tools can scope by runtime session context key", async () => {
		const tempRoot = await createTempDir();
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const sandboxKey = createSandboxKey(sandbox);
			let activeSessionId: string | null = "session-A";
			const sessionContextKey = createToolSessionContextKey(
				() => activeSessionId,
			);
			const writeTool = createTodoWriteTool(sandboxKey, sessionContextKey);

			await writeTool.executeRaw(
				JSON.stringify({
					todos: [{ id: "a", content: "A task", status: "pending" }],
				}),
				createToolContext(),
			);
			activeSessionId = "session-B";
			await writeTool.executeRaw(
				JSON.stringify({
					todos: [{ id: "b", content: "B task", status: "pending" }],
				}),
				createToolContext(),
			);

			const todosA = todoStore.get("session-A") ?? [];
			const todosB = todoStore.get("session-B") ?? [];
			expect(todosA).toHaveLength(1);
			expect(todosA[0]?.id).toBe("a");
			expect(todosB).toHaveLength(1);
			expect(todosB[0]?.id).toBe("b");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("new mode normalizes ids and exposes next task in todo_read", async () => {
		const tempRoot = await createTempDir();
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const sandboxKey = createSandboxKey(sandbox);
			const writeTool = createTodoWriteTool(sandboxKey);
			const readTool = createTodoReadTool(sandboxKey);

			const writeResult = await writeTool.executeRaw(
				JSON.stringify({
					todos: [{ content: "Design API surface", status: "pending" }],
				}),
				createToolContext(),
			);
			const writeText = expectTextResult(writeResult);
			expect(writeText).toContain("Updated todos (new): 1 pending");
			expect(writeText).toContain("Next: [design-api-surface] Design API surface");

			const stored = todoStore.get(sandbox.sessionId);
			expect(stored).toHaveLength(1);
			expect(stored?.[0]).toMatchObject({
				id: "design-api-surface",
				content: "Design API surface",
				status: "pending",
				priority: 3,
			});

			const readResult = await readTool.executeRaw("{}", createToolContext());
			const readText = expectTextResult(readResult);
			expect(readText).toContain("[ ] [design-api-surface] (p3) Design API surface");
			expect(readText).toContain("Next: [design-api-surface] Design API surface");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("append mode keeps existing tasks and deduplicates ids", async () => {
		const tempRoot = await createTempDir();
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const sandboxKey = createSandboxKey(sandbox);
			const writeTool = createTodoWriteTool(sandboxKey);

			await writeTool.executeRaw(
				JSON.stringify({
					todos: [{ id: "step", content: "first", status: "pending" }],
				}),
				createToolContext(),
			);

			const appendResult = await writeTool.executeRaw(
				JSON.stringify({
					mode: "append",
					todos: [{ id: "step", content: "second", status: "pending" }],
				}),
				createToolContext(),
			);
			const appendText = expectTextResult(appendResult);
			expect(appendText).toContain("Updated todos (append): 2 pending");

			const stored = todoStore.get(sandbox.sessionId) ?? [];
			expect(stored.map((todo) => todo.id)).toEqual(["step", "step-2"]);
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("new mode replaces existing tasks when restarting a plan", async () => {
		const tempRoot = await createTempDir();
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const sandboxKey = createSandboxKey(sandbox);
			const writeTool = createTodoWriteTool(sandboxKey);

			await writeTool.executeRaw(
				JSON.stringify({
					todos: [
						{ id: "first", content: "first", status: "pending" },
						{ id: "second", content: "second", status: "pending" },
					],
				}),
				createToolContext(),
			);

			const restartResult = await writeTool.executeRaw(
				JSON.stringify({
					mode: "new",
					todos: [{ id: "restart", content: "restart", status: "pending" }],
				}),
				createToolContext(),
			);
			expect(expectTextResult(restartResult)).toContain("Updated todos (new): 1 pending");

			const stored = todoStore.get(sandbox.sessionId) ?? [];
			expect(stored).toHaveLength(1);
			expect(stored[0]?.id).toBe("restart");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("clear mode removes all todo items", async () => {
		const tempRoot = await createTempDir();
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const sandboxKey = createSandboxKey(sandbox);
			const writeTool = createTodoWriteTool(sandboxKey);
			const readTool = createTodoReadTool(sandboxKey);

			await writeTool.executeRaw(
				JSON.stringify({
					todos: [{ id: "plan", content: "Plan", status: "pending" }],
				}),
				createToolContext(),
			);

			const clearResult = await writeTool.executeRaw(
				JSON.stringify({ mode: "clear" }),
				createToolContext(),
			);
			expect(expectTextResult(clearResult)).toContain(
				"Updated todos (clear): 0 pending, 0 in progress, 0 completed. Next: none.",
			);
			expect(todoStore.has(sandbox.sessionId)).toBe(false);

			const readResult = await readTool.executeRaw("{}", createToolContext());
			expect(expectTextResult(readResult)).toBe("Todo list is empty");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("clear mode rejects todos and updates payloads", async () => {
		const tempRoot = await createTempDir();
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const sandboxKey = createSandboxKey(sandbox);
			const writeTool = createTodoWriteTool(sandboxKey);

			const expectRejectedMessage = async (
				run: () => Promise<unknown>,
				expectedMessage: string,
			): Promise<void> => {
				try {
					await run();
					throw new Error("expected todo_write to reject");
				} catch (error) {
					expect(String(error)).toContain(expectedMessage);
				}
			};

			await expectRejectedMessage(
				() =>
					writeTool.executeRaw(
						JSON.stringify({
							mode: "clear",
							todos: [{ content: "unexpected", status: "pending" }],
						}),
						createToolContext(),
					),
				"clear mode does not accept todos",
			);

			await expectRejectedMessage(
				() =>
					writeTool.executeRaw(
						JSON.stringify({
							mode: "clear",
							updates: [{ id: "x", remove: true }],
						}),
						createToolContext(),
					),
				"clear mode does not accept updates",
			);
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("patch mode updates and removes tasks by id", async () => {
		const tempRoot = await createTempDir();
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const sandboxKey = createSandboxKey(sandbox);
			const writeTool = createTodoWriteTool(sandboxKey);

			await writeTool.executeRaw(
				JSON.stringify({
					todos: [
						{ id: "plan", content: "Plan changes", status: "pending" },
						{ id: "test", content: "Add tests", status: "pending" },
					],
				}),
				createToolContext(),
			);

			const patchResult = await writeTool.executeRaw(
				JSON.stringify({
					mode: "patch",
					updates: [
						{
							id: "plan",
							status: "in_progress",
							activeForm: "Planning now",
							priority: 1,
						},
						{
							id: "test",
							notes: "Run runtime tests after editing",
							priority: 2,
						},
					],
				}),
				createToolContext(),
			);
			expect(expectTextResult(patchResult)).toContain("Updated todos (patch):");

			let stored = todoStore.get(sandbox.sessionId) ?? [];
			expect(stored.find((todo) => todo.id === "plan")).toMatchObject({
				status: "in_progress",
				activeForm: "Planning now",
				priority: 1,
			});
			expect(stored.find((todo) => todo.id === "test")).toMatchObject({
				priority: 2,
				notes: "Run runtime tests after editing",
			});

			const removeResult = await writeTool.executeRaw(
				JSON.stringify({
					mode: "patch",
					updates: [{ id: "test", remove: true }],
				}),
				createToolContext(),
			);
			expect(expectTextResult(removeResult)).toContain("Updated todos (patch):");

			stored = todoStore.get(sandbox.sessionId) ?? [];
			expect(stored).toHaveLength(1);
			expect(stored[0]?.id).toBe("plan");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("patch mode treats null patch fields as no change", async () => {
		const tempRoot = await createTempDir();
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const sandboxKey = createSandboxKey(sandbox);
			const writeTool = createTodoWriteTool(sandboxKey);

			await writeTool.executeRaw(
				JSON.stringify({
					todos: [
						{
							id: "plan",
							content: "Plan changes",
							status: "pending",
							priority: 2,
							notes: "keep notes",
							activeForm: "keep active form",
						},
					],
				}),
				createToolContext(),
			);

			const patchResult = await writeTool.executeRaw(
				JSON.stringify({
					mode: "patch",
					updates: [
						{
							id: "plan",
							content: null,
							status: "in_progress",
							priority: null,
							notes: null,
							activeForm: null,
						},
					],
				}),
				createToolContext(),
			);
			expect(expectTextResult(patchResult)).toContain("Updated todos (patch):");

			const stored = todoStore.get(sandbox.sessionId) ?? [];
			expect(stored).toHaveLength(1);
			expect(stored[0]).toMatchObject({
				id: "plan",
				content: "Plan changes",
				status: "in_progress",
				priority: 2,
				notes: "keep notes",
				activeForm: "keep active form",
			});
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("write rejects multiple in_progress tasks and keeps previous state", async () => {
		const tempRoot = await createTempDir();
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const sandboxKey = createSandboxKey(sandbox);
			const writeTool = createTodoWriteTool(sandboxKey);

			await writeTool.executeRaw(
				JSON.stringify({
					todos: [
						{ id: "first", content: "First", status: "in_progress" },
						{ id: "second", content: "Second", status: "pending" },
					],
				}),
				createToolContext(),
			);
			const before = structuredClone(todoStore.get(sandbox.sessionId) ?? []);

			const invalidResult = await writeTool.executeRaw(
				JSON.stringify({
					mode: "patch",
					updates: [{ id: "second", status: "in_progress" }],
				}),
				createToolContext(),
			);
			const invalidText = expectTextResult(invalidResult);
			expect(invalidText).toContain("Invalid todo state:");

			const after = todoStore.get(sandbox.sessionId) ?? [];
			expect(after).toEqual(before);
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("session meta serialization roundtrip keeps todo items", () => {
		const meta = mergeTodosIntoSessionMeta(
			{ run_label: "demo" },
			[
				{
					id: "plan",
					content: "Plan",
					status: "in_progress",
					priority: 1,
					notes: "now",
				},
				{
					id: "test",
					content: "Test",
					status: "pending",
					priority: 2,
				},
			],
		);
		expect(meta?.run_label).toBe("demo");
		expect(Array.isArray(meta?.[TODO_SESSION_META_KEY])).toBe(true);

		const restored = readTodosFromSessionMeta(meta);
		expect(restored).toHaveLength(2);
		expect(restored[0]).toMatchObject({
			id: "plan",
			status: "in_progress",
			priority: 1,
		});
		expect(restored[1]).toMatchObject({
			id: "test",
			status: "pending",
			priority: 2,
		});
	});
});
