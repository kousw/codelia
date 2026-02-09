import type { Tool } from "@codelia/core";
import { defineTool, TaskComplete } from "@codelia/core";
import { z } from "zod";

export const createDoneTool = (): Tool =>
	defineTool({
		name: "done",
		description: "Mark the task as complete and return a final message.",
		input: z.object({
			message: z.string().describe("Final user-facing completion message."),
		}),
		execute: async (input) => {
			throw new TaskComplete(input.message);
		},
	});
