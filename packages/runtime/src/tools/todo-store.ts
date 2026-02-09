export type TodoItem = {
	content: string;
	status: "pending" | "in_progress" | "completed";
	activeForm?: string;
};

export const todoStore = new Map<string, TodoItem[]>();
