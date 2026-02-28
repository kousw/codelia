import type { DependencyKey, Tool } from "@codelia/core";
import { defineTool } from "@codelia/core";
import { z } from "zod";
import { getSandboxContext, type SandboxContext } from "../sandbox/context";
import {
	getToolSessionContext,
	type ToolSessionContext,
} from "./session-context";
import {
	clearTodosForSession,
	countInProgressTodos,
	getTodosForSession,
	getTodoStats,
	normalizeTodoId,
	normalizeTodoItems,
	pickNextTodo,
	setTodosForSession,
	type TodoItem,
	type TodoItemInput,
} from "./todo-store";

const todoStatusSchema = z.enum(["pending", "in_progress", "completed"]);
const todoPrioritySchema = z.number().int().min(1).max(5);

const todoItemSchema = z.object({
	id: z
		.string()
		.min(1)
		.optional()
		.describe("Optional stable ID. Keep if the task already exists."),
	content: z.string().min(1).describe("Todo item text."),
	status: todoStatusSchema.describe("Todo status."),
	priority: todoPrioritySchema
		.optional()
		.describe("Priority 1(high)-5(low). Default is 3."),
	notes: z.string().optional().describe("Optional implementation notes."),
	activeForm: z
		.string()
		.optional()
		.describe("Optional in-progress phrasing for UI display."),
});

const todoPatchItemSchema = z.object({
	id: z.string().min(1).describe("Target todo ID."),
	remove: z
		.boolean()
		.optional()
		.describe("Set true to remove the todo item."),
	content: z
		.string()
		.min(1)
		.nullable()
		.default(null)
		.describe("Updated todo text (null keeps current)."),
	status: todoStatusSchema
		.nullable()
		.default(null)
		.describe("Updated status (null keeps current)."),
	priority: todoPrioritySchema
		.nullable()
		.default(null)
		.describe("Updated priority (null keeps current)."),
	notes: z
		.string()
		.nullable()
		.default(null)
		.describe("Updated notes (null keeps current, empty clears)."),
	activeForm: z
		.string()
		.nullable()
		.default(null)
		.describe("Updated in-progress phrasing (null keeps current, empty clears)."),
});

const todoWriteInputSchema = z
	.object({
		mode: z
			.enum(["new", "append", "patch", "clear"])
			.default("new")
			.describe("Update mode. Default is new."),
		todos: z
			.array(todoItemSchema)
			.default([])
			.describe("Todo items for new/append mode."),
		updates: z
			.array(todoPatchItemSchema)
			.default([])
			.describe("Patch operations for patch mode."),
	})
	.superRefine((input, ctx) => {
		if (input.mode === "patch") {
			if (input.updates.length === 0) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["updates"],
					message: "patch mode requires at least one update item.",
				});
			}
			if (input.todos.length > 0) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["todos"],
					message: "patch mode does not accept todos.",
				});
			}
			return;
		}
		if (input.mode === "clear") {
			if (input.todos.length > 0) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["todos"],
					message: "clear mode does not accept todos.",
				});
			}
			if (input.updates.length > 0) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["updates"],
					message: "clear mode does not accept updates.",
				});
			}
			return;
		}
		if (input.todos.length === 0) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["todos"],
				message: `${input.mode} mode requires at least one todo item.`,
			});
		}
		if (input.updates.length > 0) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["updates"],
				message: `${input.mode} mode does not accept updates.`,
			});
		}
	});

type TodoPatchItemInput = z.infer<typeof todoPatchItemSchema>;

const loadSessionTodos = (sessionId: string): TodoItem[] =>
	getTodosForSession(sessionId);

const formatSuccess = (
	mode: "new" | "append" | "patch" | "clear",
	todos: ReadonlyArray<TodoItem>,
): string => {
	const stats = getTodoStats(todos);
	const nextTodo = pickNextTodo(todos);
	const nextHint = nextTodo
		? ` Next: [${nextTodo.id}] ${nextTodo.content}.`
		: " Next: none.";
	return `Updated todos (${mode}): ${stats.pending} pending, ${stats.inProgress} in progress, ${stats.completed} completed.${nextHint}`;
};

const withPatchApplied = (
	currentTodos: ReadonlyArray<TodoItem>,
	updates: ReadonlyArray<TodoPatchItemInput>,
): { todos: TodoItem[]; error?: string } => {
	const normalizedUpdates = updates.map((update) => ({
		...update,
		id: normalizeTodoId(update.id),
	}));
	const currentIds = new Set(currentTodos.map((todo) => todo.id));
	const missingIds = normalizedUpdates
		.map((update) => update.id)
		.filter((id) => !currentIds.has(id));
	if (missingIds.length > 0) {
		return {
			todos: [...currentTodos],
			error: `Patch failed: unknown todo id(s): ${Array.from(new Set(missingIds)).join(", ")}`,
		};
	}

	let nextInputs: TodoItemInput[] = currentTodos.map((todo) => ({ ...todo }));
	for (const update of normalizedUpdates) {
		const index = nextInputs.findIndex((todo) => todo.id === update.id);
		if (index < 0) continue;
		if (update.remove) {
			nextInputs = [
				...nextInputs.slice(0, index),
				...nextInputs.slice(index + 1),
			];
			continue;
		}
		const previous = nextInputs[index];
		nextInputs[index] = {
			...previous,
			content: update.content !== null ? update.content : previous.content,
			status: update.status !== null ? update.status : previous.status,
			priority: update.priority !== null ? update.priority : previous.priority,
			notes: update.notes !== null ? update.notes : previous.notes,
			activeForm:
				update.activeForm !== null
					? update.activeForm
					: previous.activeForm,
		};
	}
	return { todos: normalizeTodoItems(nextInputs) };
};

export const createTodoWriteTool = (
	sandboxKey: DependencyKey<SandboxContext>,
	sessionContextKey?: DependencyKey<ToolSessionContext>,
): Tool =>
	defineTool({
		name: "todo_write",
		description:
			"Maintain the in-session todo plan with new, append, patch, or clear updates.",
		input: todoWriteInputSchema,
		execute: async (input, ctx) => {
			const sandbox = await getSandboxContext(ctx, sandboxKey);
			const sessionContext = sessionContextKey
				? await getToolSessionContext(ctx, sessionContextKey)
				: null;
			const todoSessionId =
				sessionContext?.sessionId && sessionContext.sessionId.length > 0
					? sessionContext.sessionId
					: sandbox.sessionId;
			const currentTodos = loadSessionTodos(todoSessionId);

			let mode: "new" | "append" | "patch" | "clear" = input.mode;
			let nextTodos: TodoItem[] = [];

			if (input.mode === "patch") {
				mode = "patch";
				const patched = withPatchApplied(currentTodos, input.updates);
				if (patched.error) return patched.error;
				nextTodos = patched.todos;
			} else if (input.mode === "append") {
				mode = "append";
				nextTodos = normalizeTodoItems([...currentTodos, ...input.todos]);
			} else if (input.mode === "clear") {
				mode = "clear";
				nextTodos = [];
			} else {
				mode = "new";
				nextTodos = normalizeTodoItems(input.todos);
			}

			const inProgressCount = countInProgressTodos(nextTodos);
			if (inProgressCount > 1) {
				return `Invalid todo state: ${inProgressCount} items are in_progress. Keep at most one item in_progress so tasks can be handled one-by-one.`;
			}

			if (nextTodos.length === 0) {
				clearTodosForSession(todoSessionId);
			} else {
				setTodosForSession(todoSessionId, nextTodos);
			}
			return formatSuccess(mode, nextTodos);
		},
	});
