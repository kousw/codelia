import type { DependencyKey, Tool } from "@codelia/core";
import { defineTool } from "@codelia/core";
import { z } from "zod";
import { getSandboxContext, type SandboxContext } from "../sandbox/context";
import { todoStore } from "./todo-store";

export const createTodoReadTool = (
	sandboxKey: DependencyKey<SandboxContext>,
): Tool =>
	defineTool({
		name: "todo_read",
		description: "Read the in-session todo list.",
		input: z.object({}),
		execute: async (_input, ctx) => {
			const sandbox = await getSandboxContext(ctx, sandboxKey);
			const todos = todoStore.get(sandbox.sessionId) ?? [];
			if (!todos.length) return "Todo list is empty";
			return todos
				.map((todo, index) => {
					const status =
						todo.status === "completed"
							? "[x]"
							: todo.status === "in_progress"
								? "[>]"
								: "[ ]";
					return `${index + 1}. ${status} ${todo.content}`;
				})
				.join("\n");
		},
	});
