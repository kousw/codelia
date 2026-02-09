import type { DependencyKey, Tool } from "@codelia/core";
import { defineTool } from "@codelia/core";
import { z } from "zod";
import { getSandboxContext, type SandboxContext } from "../sandbox/context";
import { todoStore } from "./todo-store";

export const createTodoWriteTool = (
	sandboxKey: DependencyKey<SandboxContext>,
): Tool =>
	defineTool({
		name: "todo_write",
		description: "Replace the in-session todo list.",
		input: z.object({
			todos: z.array(
				z.object({
					content: z.string().describe("Todo item text."),
					status: z
						.enum(["pending", "in_progress", "completed"])
						.describe("Todo status."),
					activeForm: z
						.string()
						.optional()
						.describe("Optional in-progress phrasing for UI display."),
				}),
			),
		}),
		execute: async (input, ctx) => {
			const sandbox = await getSandboxContext(ctx, sandboxKey);
			todoStore.set(sandbox.sessionId, input.todos);
			const stats = {
				pending: input.todos.filter((todo) => todo.status === "pending").length,
				inProgress: input.todos.filter((todo) => todo.status === "in_progress")
					.length,
				completed: input.todos.filter((todo) => todo.status === "completed")
					.length,
			};
			return `Updated todos: ${stats.pending} pending, ${stats.inProgress} in progress, ${stats.completed} completed`;
		},
	});
