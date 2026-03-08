import type { DependencyKey, Tool, ToolContext } from "@codelia/core";
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
	getTodoStats,
	getTodosForSession,
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
	remove: z.boolean().optional().describe("Set true to remove the todo item."),
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
		.describe(
			"Updated in-progress phrasing (null keeps current, empty clears).",
		),
});

const todoNewInputSchema = z.object({
	todos: z
		.array(todoItemSchema)
		.min(1)
		.describe("Full todo list to start or replace the current plan."),
}).strict();

const todoAppendInputSchema = z.object({
	todos: z
		.array(todoItemSchema)
		.min(1)
		.describe("Todo items to append to the current plan."),
}).strict();

const todoPatchInputSchema = z.object({
	updates: z
		.array(todoPatchItemSchema)
		.min(1)
		.describe("Patch operations for existing todo items."),
}).strict();

const todoClearInputSchema = z.object({}).strict();

type TodoPatchItemInput = z.infer<typeof todoPatchItemSchema>;
const statusSymbol: Record<"pending" | "in_progress" | "completed", string> = {
	pending: "[ ]",
	in_progress: "[>]",
	completed: "[x]",
};

const formatSuccess = (
	mode: "new" | "append" | "patch" | "clear",
	todos: ReadonlyArray<TodoItem>,
): string => {
	const stats = getTodoStats(todos);
	const nextTodo = pickNextTodo(todos);
	const nextHint = nextTodo ? ` Next: [${nextTodo.id}].` : " Next: none.";
	const summary = `Updated todos (${mode}): ${stats.pending} pending, ${stats.inProgress} in progress, ${stats.completed} completed.${nextHint}`;
	if (todos.length === 0) {
		return summary;
	}
	const lines: string[] = [summary, "Todo plan:"];
	for (const [index, todo] of todos.entries()) {
		const label =
			todo.status === "in_progress" && todo.activeForm
				? todo.activeForm
				: todo.content;
		lines.push(
			`${index + 1}. ${statusSymbol[todo.status]} [${todo.id}] (p${todo.priority}) ${label}`,
		);
	}
	lines.push(
		`Summary: ${stats.pending} pending, ${stats.inProgress} in progress, ${stats.completed} completed`,
	);
	lines.push(nextTodo ? `Next: [${nextTodo.id}]` : "Next: none");
	return lines.join("\n");
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
		const knownIds = currentTodos.map((todo) => todo.id);
		return {
			todos: [...currentTodos],
			error: `Patch failed: unknown todo id(s): ${Array.from(new Set(missingIds)).join(", ")}. Existing id(s): ${knownIds.length ? knownIds.join(", ") : "(none)"}. Run todo_read to inspect the current plan before patching.`,
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
				update.activeForm !== null ? update.activeForm : previous.activeForm,
		};
	}
	return { todos: normalizeTodoItems(nextInputs) };
};

const resolveTodoSessionId = async (
	ctx: ToolContext,
	sandboxKey: DependencyKey<SandboxContext>,
	sessionContextKey?: DependencyKey<ToolSessionContext>,
): Promise<string> => {
	const sandbox = await getSandboxContext(ctx, sandboxKey);
	const sessionContext = sessionContextKey
		? await getToolSessionContext(ctx, sessionContextKey)
		: null;
	return sessionContext?.sessionId && sessionContext.sessionId.length > 0
		? sessionContext.sessionId
		: sandbox.sessionId;
};

const applyTodoMutation = (
	sessionId: string,
	input:
		| { mode: "new"; todos: ReadonlyArray<TodoItemInput> }
		| { mode: "append"; todos: ReadonlyArray<TodoItemInput> }
		| { mode: "patch"; updates: ReadonlyArray<TodoPatchItemInput> }
		| { mode: "clear" },
	outputMode: "new" | "append" | "patch" | "clear",
): string => {
	const currentTodos = getTodosForSession(sessionId);
	let nextTodos: TodoItem[] = [];

	if (input.mode === "patch") {
		const patched = withPatchApplied(currentTodos, input.updates);
		if (patched.error) return patched.error;
		nextTodos = patched.todos;
	} else if (input.mode === "append") {
		nextTodos = normalizeTodoItems([...currentTodos, ...input.todos]);
	} else if (input.mode === "clear") {
		nextTodos = [];
	} else {
		nextTodos = normalizeTodoItems(input.todos);
	}

	const inProgressCount = countInProgressTodos(nextTodos);
	if (inProgressCount > 1) {
		const inProgressIds = nextTodos
			.filter((todo) => todo.status === "in_progress")
			.map((todo) => todo.id);
		return `Invalid todo state: ${inProgressCount} items are in_progress (${inProgressIds.join(", ")}). Keep at most one item in_progress so tasks can be handled one-by-one.`;
	}

	if (nextTodos.length === 0) {
		clearTodosForSession(sessionId);
	} else {
		setTodosForSession(sessionId, nextTodos);
	}
	return formatSuccess(outputMode, nextTodos);
};

const createTodoMutationTool = <TInput>(
	name: string,
	description: string,
	input: z.ZodType<TInput>,
	executeMutation: (sessionId: string, input: TInput) => string,
	sandboxKey: DependencyKey<SandboxContext>,
	sessionContextKey?: DependencyKey<ToolSessionContext>,
): Tool =>
	defineTool({
		name,
		description,
		input,
		execute: async (parsedInput, ctx) => {
			const sessionId = await resolveTodoSessionId(
				ctx,
				sandboxKey,
				sessionContextKey,
			);
			return executeMutation(sessionId, parsedInput);
		},
	});

export const createTodoNewTool = (
	sandboxKey: DependencyKey<SandboxContext>,
	sessionContextKey?: DependencyKey<ToolSessionContext>,
): Tool =>
	createTodoMutationTool(
		"todo_new",
		"Start or replace the in-session todo plan with a full task list.",
		todoNewInputSchema,
		(sessionId, input) =>
			applyTodoMutation(
				sessionId,
				{ mode: "new", todos: input.todos },
				"new",
			),
		sandboxKey,
		sessionContextKey,
	);

export const createTodoAppendTool = (
	sandboxKey: DependencyKey<SandboxContext>,
	sessionContextKey?: DependencyKey<ToolSessionContext>,
): Tool =>
	createTodoMutationTool(
		"todo_append",
		"Append newly discovered tasks to the in-session todo plan.",
		todoAppendInputSchema,
		(sessionId, input) =>
			applyTodoMutation(
				sessionId,
				{ mode: "append", todos: input.todos },
				"append",
			),
		sandboxKey,
		sessionContextKey,
	);

export const createTodoPatchTool = (
	sandboxKey: DependencyKey<SandboxContext>,
	sessionContextKey?: DependencyKey<ToolSessionContext>,
): Tool =>
	createTodoMutationTool(
		"todo_patch",
		"Update or remove todo items in the in-session plan by stable ID.",
		todoPatchInputSchema,
		(sessionId, input) =>
			applyTodoMutation(
				sessionId,
				{ mode: "patch", updates: input.updates },
				"patch",
			),
		sandboxKey,
		sessionContextKey,
	);

export const createTodoClearTool = (
	sandboxKey: DependencyKey<SandboxContext>,
	sessionContextKey?: DependencyKey<ToolSessionContext>,
): Tool =>
	createTodoMutationTool(
		"todo_clear",
		"Clear the in-session todo plan.",
		todoClearInputSchema,
		(sessionId) => applyTodoMutation(sessionId, { mode: "clear" }, "clear"),
		sandboxKey,
		sessionContextKey,
	);
