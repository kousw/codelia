import type { DependencyKey, Tool } from "@codelia/core";
import { defineTool } from "@codelia/core";
import { z } from "zod";
import { getSandboxContext, type SandboxContext } from "../sandbox/context";
import {
	getToolSessionContext,
	type ToolSessionContext,
} from "./session-context";
import {
	countInProgressTodos,
	getTodosForSession,
	getTodoStats,
	pickNextTodo,
	sortTodosForDisplay,
} from "./todo-store";

const statusSymbol: Record<"pending" | "in_progress" | "completed", string> = {
	pending: "[ ]",
	in_progress: "[>]",
	completed: "[x]",
};

export const createTodoReadTool = (
	sandboxKey: DependencyKey<SandboxContext>,
	sessionContextKey?: DependencyKey<ToolSessionContext>,
): Tool =>
	defineTool({
		name: "todo_read",
		description: "Read the in-session todo plan with execution order and next step.",
		input: z.object({}),
		execute: async (_input, ctx) => {
			const sandbox = await getSandboxContext(ctx, sandboxKey);
			const sessionContext = sessionContextKey
				? await getToolSessionContext(ctx, sessionContextKey)
				: null;
			const todoSessionId =
				sessionContext?.sessionId && sessionContext.sessionId.length > 0
					? sessionContext.sessionId
					: sandbox.sessionId;
			const todos = getTodosForSession(todoSessionId);
			if (!todos.length) return "Todo list is empty";
			const orderedTodos = sortTodosForDisplay(todos);
			const lines: string[] = ["Todo plan:"];
			for (const [index, todo] of orderedTodos.entries()) {
				const label =
					todo.status === "in_progress" && todo.activeForm
						? todo.activeForm
						: todo.content;
				lines.push(
					`${index + 1}. ${statusSymbol[todo.status]} [${todo.id}] (p${todo.priority}) ${label}`,
				);
				if (todo.notes) {
					lines.push(`   note: ${todo.notes}`);
				}
			}
			const stats = getTodoStats(orderedTodos);
			const nextTodo = pickNextTodo(orderedTodos);
			lines.push(
				`Summary: ${stats.pending} pending, ${stats.inProgress} in progress, ${stats.completed} completed`,
			);
			if (nextTodo) {
				lines.push(`Next: [${nextTodo.id}] ${nextTodo.content}`);
			} else {
				lines.push("Next: none");
			}
			const inProgressCount = countInProgressTodos(orderedTodos);
			if (inProgressCount > 1) {
				lines.push(
					`Warning: ${inProgressCount} items are in_progress (expected at most 1).`,
				);
			}
			return lines.join("\n");
		},
	});
