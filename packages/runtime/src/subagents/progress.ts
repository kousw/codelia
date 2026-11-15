import type { AgentEvent, SessionRecord } from "@codelia/core";
import type { TaskProgress } from "@codelia/shared-types";

const MAX_TOOL_NAME_LENGTH = 128;

const toolName = (value: string): string =>
	value.length > MAX_TOOL_NAME_LENGTH
		? value.slice(0, MAX_TOOL_NAME_LENGTH)
		: value;

/**
 * Derives the parent-visible progress of a child run. Only counts, phase and
 * tool names are tracked; arguments and results stay in the child session.
 */
export const createTaskProgressTracker = (options: {
	maxSteps?: number;
	now?: () => string;
}) => {
	const now = options.now ?? (() => new Date().toISOString());
	let progress: TaskProgress = {
		step: 0,
		...(options.maxSteps !== undefined ? { max_steps: options.maxSteps } : {}),
		phase: "model",
		tool_calls: 0,
		updated_at: now(),
	};
	const update = (next: Omit<TaskProgress, "updated_at">): TaskProgress => {
		progress = { ...next, updated_at: now() };
		return progress;
	};
	const withoutCurrent = (): Omit<TaskProgress, "updated_at"> => {
		const { current_tool: _current, updated_at: _at, ...rest } = progress;
		return rest;
	};

	/** A model request starts a new step. */
	const onRecord = (record: SessionRecord): TaskProgress | null =>
		record.type === "llm.request"
			? update({
					...withoutCurrent(),
					step: progress.step + 1,
					phase: "model",
				})
			: null;

	const onEvent = (event: AgentEvent): TaskProgress | null => {
		switch (event.type) {
			case "tool_call":
				return update({
					...withoutCurrent(),
					phase: "tool",
					tool_calls: progress.tool_calls + 1,
					current_tool: {
						name: toolName(event.tool),
						tool_call_id: event.tool_call_id,
						started_at: now(),
					},
				});
			case "tool_result":
				return update({
					...withoutCurrent(),
					phase: "model",
					last_tool: {
						name: toolName(event.tool),
						status: event.is_error ? "error" : "ok",
						finished_at: now(),
					},
				});
			case "compaction_start":
				return update({ ...withoutCurrent(), phase: "compacting" });
			case "compaction_complete":
				return update({ ...withoutCurrent(), phase: "model" });
			case "final":
				return update({ ...withoutCurrent(), phase: "finishing" });
			default:
				return null;
		}
	};

	return { onRecord, onEvent, snapshot: () => progress };
};

/** Validates a child-reported progress object before it reaches the parent UI. */
export const parseTaskProgress = (raw: unknown): TaskProgress | null => {
	if (typeof raw !== "object" || raw === null) return null;
	const value = raw as Record<string, unknown>;
	const count = (entry: unknown) =>
		typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0;
	const text = (entry: unknown) =>
		typeof entry === "string" &&
		entry.length > 0 &&
		entry.length <= MAX_TOOL_NAME_LENGTH * 2;
	const record = (entry: unknown) =>
		typeof entry === "object" && entry !== null
			? (entry as Record<string, unknown>)
			: null;
	if (
		!count(value.step) ||
		!count(value.tool_calls) ||
		(value.max_steps !== undefined && !count(value.max_steps)) ||
		!["model", "tool", "compacting", "finishing"].includes(
			value.phase as string,
		) ||
		!text(value.updated_at)
	) {
		return null;
	}
	const current = record(value.current_tool);
	const last = record(value.last_tool);
	if (
		value.current_tool !== undefined &&
		!(
			current &&
			text(current.name) &&
			text(current.tool_call_id) &&
			text(current.started_at)
		)
	) {
		return null;
	}
	if (
		value.last_tool !== undefined &&
		!(
			last &&
			text(last.name) &&
			(last.status === "ok" || last.status === "error") &&
			text(last.finished_at)
		)
	) {
		return null;
	}
	return {
		step: value.step as number,
		...(value.max_steps !== undefined
			? { max_steps: value.max_steps as number }
			: {}),
		phase: value.phase as TaskProgress["phase"],
		...(current
			? {
					current_tool: {
						name: current.name as string,
						tool_call_id: current.tool_call_id as string,
						started_at: current.started_at as string,
					},
				}
			: {}),
		...(last
			? {
					last_tool: {
						name: last.name as string,
						status: last.status as "ok" | "error",
						finished_at: last.finished_at as string,
					},
				}
			: {}),
		tool_calls: value.tool_calls as number,
		updated_at: value.updated_at as string,
	};
};
