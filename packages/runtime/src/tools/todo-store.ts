export type TodoStatus = "pending" | "in_progress" | "completed";
export type TodoPriority = 1 | 2 | 3 | 4 | 5;
export const TODO_SESSION_META_KEY = "codelia_todos";

export type TodoItemInput = {
	id?: string;
	content: string;
	status: TodoStatus;
	priority?: number;
	notes?: string;
	activeForm?: string;
};

export type TodoItem = {
	id: string;
	content: string;
	status: TodoStatus;
	priority: TodoPriority;
	notes?: string;
	activeForm?: string;
};

const DEFAULT_TODO_PRIORITY: TodoPriority = 3;

const normalizeOptionalText = (value?: string): string | undefined => {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length ? trimmed : undefined;
};

const isTodoStatus = (value: unknown): value is TodoStatus =>
	value === "pending" || value === "in_progress" || value === "completed";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeTodoIdBase = (value: string): string => {
	const trimmed = value.trim().toLowerCase();
	const withHyphen = trimmed.replace(/\s+/g, "-");
	const safe = withHyphen.replace(/[^a-z0-9._-]+/g, "-");
	const compact = safe.replace(/-+/g, "-");
	const stripped = compact.replace(/^[-_.]+|[-_.]+$/g, "");
	return stripped.length ? stripped : "todo";
};

const slugFromContent = (content: string): string => {
	const source = normalizeOptionalText(content) ?? "todo";
	return normalizeTodoIdBase(source);
};

const toTodoPriority = (value?: number): TodoPriority => {
	const numericValue = typeof value === "number" ? value : Number.NaN;
	if (!Number.isInteger(numericValue)) return DEFAULT_TODO_PRIORITY;
	if (numericValue <= 1) return 1;
	if (numericValue >= 5) return 5;
	return numericValue as TodoPriority;
};

const toUniqueId = (baseId: string, usedIds: Set<string>): string => {
	let candidate = baseId;
	let suffix = 2;
	while (usedIds.has(candidate)) {
		candidate = `${baseId}-${suffix}`;
		suffix += 1;
	}
	usedIds.add(candidate);
	return candidate;
};

export const normalizeTodoId = (value: string): string =>
	normalizeTodoIdBase(value);

export const normalizeTodoItems = (
	todos: ReadonlyArray<TodoItemInput | TodoItem>,
): TodoItem[] => {
	const usedIds = new Set<string>();
	return todos.map((todo, index) => {
		const content = normalizeOptionalText(todo.content) ?? `Todo ${index + 1}`;
		const preferredId =
			typeof todo.id === "string" && todo.id.trim().length
				? normalizeTodoIdBase(todo.id)
				: slugFromContent(content);
		return {
			id: toUniqueId(preferredId, usedIds),
			content,
			status: todo.status,
			priority: toTodoPriority(todo.priority),
			notes: normalizeOptionalText(todo.notes),
			activeForm: normalizeOptionalText(todo.activeForm),
		};
	});
};

export const setTodosForSession = (
	sessionId: string,
	todos: ReadonlyArray<TodoItemInput | TodoItem>,
): TodoItem[] => {
	const normalized = normalizeTodoItems(todos);
	todoStore.set(sessionId, normalized);
	return normalized;
};

export const getTodosForSession = (sessionId: string): TodoItem[] =>
	normalizeTodoItems(todoStore.get(sessionId) ?? []);

export const clearTodosForSession = (sessionId: string): void => {
	todoStore.delete(sessionId);
};

export const readTodosFromSessionMeta = (
	meta?: Record<string, unknown>,
): TodoItem[] => {
	const raw = meta?.[TODO_SESSION_META_KEY];
	if (!Array.isArray(raw)) return [];
	const todos: TodoItemInput[] = [];
	for (const entry of raw) {
		if (!isRecord(entry)) continue;
		const status = entry.status;
		if (!isTodoStatus(status)) continue;
		const content = typeof entry.content === "string" ? entry.content : "";
		todos.push({
			id: typeof entry.id === "string" ? entry.id : undefined,
			content,
			status,
			priority: typeof entry.priority === "number" ? entry.priority : undefined,
			notes: typeof entry.notes === "string" ? entry.notes : undefined,
			activeForm:
				typeof entry.activeForm === "string" ? entry.activeForm : undefined,
		});
	}
	return normalizeTodoItems(todos);
};

export const mergeTodosIntoSessionMeta = (
	meta: Record<string, unknown> | undefined,
	todos: ReadonlyArray<TodoItem>,
): Record<string, unknown> | undefined => {
	const nextMeta = meta ? { ...meta } : {};
	if (todos.length > 0) {
		nextMeta[TODO_SESSION_META_KEY] = todos.map((todo) => ({ ...todo }));
	} else {
		delete nextMeta[TODO_SESSION_META_KEY];
	}
	return Object.keys(nextMeta).length > 0 ? nextMeta : undefined;
};

export const countInProgressTodos = (todos: ReadonlyArray<TodoItem>): number =>
	todos.filter((todo) => todo.status === "in_progress").length;

export const getTodoStats = (
	todos: ReadonlyArray<TodoItem>,
): { pending: number; inProgress: number; completed: number } => ({
	pending: todos.filter((todo) => todo.status === "pending").length,
	inProgress: todos.filter((todo) => todo.status === "in_progress").length,
	completed: todos.filter((todo) => todo.status === "completed").length,
});

const statusOrder: Record<TodoStatus, number> = {
	in_progress: 0,
	pending: 1,
	completed: 2,
};

export const sortTodosForDisplay = (
	todos: ReadonlyArray<TodoItem>,
): TodoItem[] =>
	todos
		.map((todo, index) => ({ todo, index }))
		.sort((a, b) => {
			const statusDiff = statusOrder[a.todo.status] - statusOrder[b.todo.status];
			if (statusDiff !== 0) return statusDiff;
			const priorityDiff = a.todo.priority - b.todo.priority;
			if (priorityDiff !== 0) return priorityDiff;
			return a.index - b.index;
		})
		.map((entry) => entry.todo);

export const pickNextTodo = (
	todos: ReadonlyArray<TodoItem>,
): TodoItem | null => {
	const inProgress = todos.find((todo) => todo.status === "in_progress");
	if (inProgress) return inProgress;
	const pending = sortTodosForDisplay(todos).find(
		(todo) => todo.status === "pending",
	);
	return pending ?? null;
};

export const todoStore = new Map<string, TodoItem[]>();
