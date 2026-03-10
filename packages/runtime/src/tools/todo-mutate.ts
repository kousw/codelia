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

const todoNewInputSchema = z
	.object({
		todos: z
			.array(todoItemSchema)
			.min(1)
			.describe("Full todo list to start or replace the current plan."),
	})
	.strict();

const todoAppendInputSchema = z
	.object({
		todos: z
			.array(todoItemSchema)
			.min(1)
			.describe("Todo items to append to the current plan."),
	})
	.strict();

const todoPatchInputSchema = z
	.object({
		updates: z
			.array(todoPatchItemSchema)
			.min(1)
			.describe("Patch operations for existing todo items."),
	})
	.strict();

const todoClearInputSchema = z.object({}).strict();

type TodoPatchItemInput = z.infer<typeof todoPatchItemSchema>;
type TodoMutationMode = "new" | "append" | "patch" | "clear";
type TodoMutationSummary =
	| {
			mode: "new";
			ids: string[];
	  }
	| {
			mode: "append";
			addedIds: string[];
	  }
	| {
			mode: "patch";
			updatedIds: string[];
			removedIds: string[];
	  }
	| {
			mode: "clear";
	  };

const TODO_ID_PREVIEW_LIMIT = 5;

const formatTodoIdPreview = (ids: ReadonlyArray<string>): string => {
	if (ids.length === 0) return "(none)";
	const preview = ids
		.slice(0, TODO_ID_PREVIEW_LIMIT)
		.map((id) => `[${id}]`)
		.join(", ");
	if (ids.length <= TODO_ID_PREVIEW_LIMIT) {
		return preview;
	}
	return `${preview}, +${ids.length - TODO_ID_PREVIEW_LIMIT} more`;
};

const formatItemCount = (count: number): string =>
	`${count} item${count === 1 ? "" : "s"}`;

const formatSuccess = (
	mode: TodoMutationMode,
	todos: ReadonlyArray<TodoItem>,
	delta: TodoMutationSummary,
): string => {
	const stats = getTodoStats(todos);
	const nextTodo = pickNextTodo(todos);
	const nextHint = nextTodo ? ` Next: [${nextTodo.id}].` : " Next: none.";
	const summary = `Summary: ${stats.pending} pending, ${stats.inProgress} in progress, ${stats.completed} completed.${nextHint}`;
	if (delta.mode === "clear") {
		return `Updated todos (${mode}): ${stats.pending} pending, ${stats.inProgress} in progress, ${stats.completed} completed.${nextHint}`;
	}
	let deltaText = "";
	if (delta.mode === "new") {
		deltaText = `replaced plan with ${formatItemCount(delta.ids.length)} (${formatTodoIdPreview(delta.ids)})`;
	} else if (delta.mode === "append") {
		deltaText = `added ${formatItemCount(delta.addedIds.length)} (${formatTodoIdPreview(delta.addedIds)})`;
	} else {
		const parts: string[] = [];
		if (delta.updatedIds.length > 0) {
			parts.push(
				`updated ${formatItemCount(delta.updatedIds.length)} (${formatTodoIdPreview(delta.updatedIds)})`,
			);
		}
		if (delta.removedIds.length > 0) {
			parts.push(
				`removed ${formatItemCount(delta.removedIds.length)} (${formatTodoIdPreview(delta.removedIds)})`,
			);
		}
		deltaText = parts.length > 0 ? parts.join("; ") : "no effective changes";
	}
	return `Updated todos (${mode}): ${deltaText}. ${summary}`;
};

const withPatchApplied = (
	currentTodos: ReadonlyArray<TodoItem>,
	updates: ReadonlyArray<TodoPatchItemInput>,
): {
	todos: TodoItem[];
	error?: string;
	updatedIds: string[];
	removedIds: string[];
} => {
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
			updatedIds: [],
			removedIds: [],
			error: `Patch failed: unknown todo id(s): ${Array.from(new Set(missingIds)).join(", ")}. Existing id(s): ${knownIds.length ? knownIds.join(", ") : "(none)"}. Run todo_read to inspect the current plan before patching.`,
		};
	}
	const updatedIds: string[] = [];
	const removedIds: string[] = [];
	const seenUpdatedIds = new Set<string>();
	const seenRemovedIds = new Set<string>();

	let nextInputs: TodoItemInput[] = currentTodos.map((todo) => ({ ...todo }));
	for (const update of normalizedUpdates) {
		const index = nextInputs.findIndex((todo) => todo.id === update.id);
		if (index < 0) continue;
		if (update.remove) {
			nextInputs = [
				...nextInputs.slice(0, index),
				...nextInputs.slice(index + 1),
			];
			if (!seenRemovedIds.has(update.id)) {
				seenRemovedIds.add(update.id);
				removedIds.push(update.id);
			}
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
		if (!seenUpdatedIds.has(update.id)) {
			seenUpdatedIds.add(update.id);
			updatedIds.push(update.id);
		}
	}
	return { todos: normalizeTodoItems(nextInputs), updatedIds, removedIds };
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
	let delta: TodoMutationSummary;

	if (input.mode === "patch") {
		const patched = withPatchApplied(currentTodos, input.updates);
		if (patched.error) return patched.error;
		nextTodos = patched.todos;
		delta = {
			mode: "patch",
			updatedIds: patched.updatedIds,
			removedIds: patched.removedIds,
		};
	} else if (input.mode === "append") {
		nextTodos = normalizeTodoItems([...currentTodos, ...input.todos]);
		delta = {
			mode: "append",
			addedIds: nextTodos.slice(currentTodos.length).map((todo) => todo.id),
		};
	} else if (input.mode === "clear") {
		nextTodos = [];
		delta = { mode: "clear" };
	} else {
		nextTodos = normalizeTodoItems(input.todos);
		delta = { mode: "new", ids: nextTodos.map((todo) => todo.id) };
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
	return formatSuccess(outputMode, nextTodos, delta);
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
			applyTodoMutation(sessionId, { mode: "new", todos: input.todos }, "new"),
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
