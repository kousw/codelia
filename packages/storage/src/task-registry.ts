import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveStoragePaths } from "./paths";

export type TaskState =
	| "queued"
	| "running"
	| "completed"
	| "failed"
	| "cancelled";

export type TaskKind = "shell" | "subagent";

export type TaskWorkspaceMode = "live_workspace" | "worktree";

export type TaskArtifact = {
	type: "file" | "patch" | "json";
	path?: string;
	ref?: string;
	description?: string;
};

export type TaskResult = {
	summary?: string;
	stdout?: string;
	stderr?: string;
	stdout_cache_id?: string;
	stderr_cache_id?: string;
	child_session_id?: string;
	worktree_path?: string;
	exit_code?: number | null;
	signal?: string | null;
	duration_ms?: number;
	artifacts?: TaskArtifact[];
};

export type TaskRecord = {
	version: 1;
	task_id: string;
	kind: TaskKind;
	workspace_mode: TaskWorkspaceMode;
	state: TaskState;
	owner_runtime_id: string;
	owner_pid: number;
	executor_pid?: number;
	executor_pgid?: number;
	parent_session_id?: string;
	parent_run_id?: string;
	parent_tool_call_id?: string;
	child_session_id?: string;
	created_at: string;
	updated_at: string;
	started_at?: string;
	ended_at?: string;
	result?: TaskResult;
	failure_message?: string;
	cancellation_reason?: string;
	cleanup_reason?: string;
};

const TASKS_DIRNAME = "tasks";

const sortByUpdatedDesc = (tasks: TaskRecord[]): TaskRecord[] =>
	[...tasks].sort((a, b) => b.updated_at.localeCompare(a.updated_at));

const atomicWrite = async (
	filePath: string,
	payload: string,
): Promise<void> => {
	const dir = path.dirname(filePath);
	const base = path.basename(filePath);
	const tmp = path.join(
		dir,
		`${base}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
	);
	await fs.writeFile(tmp, payload, "utf8");
	await fs.rename(tmp, filePath);
};

const isTaskState = (value: unknown): value is TaskState =>
	value === "queued" ||
	value === "running" ||
	value === "completed" ||
	value === "failed" ||
	value === "cancelled";

const isTaskKind = (value: unknown): value is TaskKind =>
	value === "shell" || value === "subagent";

const isWorkspaceMode = (value: unknown): value is TaskWorkspaceMode =>
	value === "live_workspace" || value === "worktree";

const isString = (value: unknown): value is string => typeof value === "string";

const isNumber = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value);

const isTaskArtifact = (value: unknown): value is TaskArtifact => {
	if (!value || typeof value !== "object") return false;
	const artifact = value as Partial<TaskArtifact>;
	return (
		(artifact.type === "file" ||
			artifact.type === "patch" ||
			artifact.type === "json") &&
			(artifact.path === undefined || isString(artifact.path)) &&
			(artifact.ref === undefined || isString(artifact.ref)) &&
			(artifact.description === undefined || isString(artifact.description))
	);
};

const isTaskResult = (value: unknown): value is TaskResult => {
	if (!value || typeof value !== "object") return false;
	const result = value as Partial<TaskResult>;
	return (
		(result.summary === undefined || isString(result.summary)) &&
		(result.stdout === undefined || isString(result.stdout)) &&
		(result.stderr === undefined || isString(result.stderr)) &&
		(result.stdout_cache_id === undefined || isString(result.stdout_cache_id)) &&
		(result.stderr_cache_id === undefined || isString(result.stderr_cache_id)) &&
		(result.child_session_id === undefined || isString(result.child_session_id)) &&
		(result.worktree_path === undefined || isString(result.worktree_path)) &&
		(result.exit_code === undefined || result.exit_code === null || isNumber(result.exit_code)) &&
		(result.signal === undefined || result.signal === null || isString(result.signal)) &&
		(result.duration_ms === undefined || isNumber(result.duration_ms)) &&
		(result.artifacts === undefined ||
			(Array.isArray(result.artifacts) && result.artifacts.every(isTaskArtifact)))
	);
};

const normalizeTaskRecord = (value: unknown): TaskRecord | null => {
	if (!value || typeof value !== "object") return null;
	const record = value as Partial<TaskRecord>;
	if (
		record.version !== 1 ||
		!isString(record.task_id) ||
		!isTaskKind(record.kind) ||
		!isWorkspaceMode(record.workspace_mode) ||
		!isTaskState(record.state) ||
		!isString(record.owner_runtime_id) ||
		!isNumber(record.owner_pid) ||
		!isString(record.created_at) ||
		!isString(record.updated_at)
	) {
		return null;
	}
	if (record.executor_pid !== undefined && !isNumber(record.executor_pid)) {
		return null;
	}
	if (record.executor_pgid !== undefined && !isNumber(record.executor_pgid)) {
		return null;
	}
	if (record.parent_session_id !== undefined && !isString(record.parent_session_id)) {
		return null;
	}
	if (record.parent_run_id !== undefined && !isString(record.parent_run_id)) {
		return null;
	}
	if (
		record.parent_tool_call_id !== undefined &&
		!isString(record.parent_tool_call_id)
	) {
		return null;
	}
	if (record.child_session_id !== undefined && !isString(record.child_session_id)) {
		return null;
	}
	if (record.started_at !== undefined && !isString(record.started_at)) {
		return null;
	}
	if (record.ended_at !== undefined && !isString(record.ended_at)) {
		return null;
	}
	if (record.result !== undefined && !isTaskResult(record.result)) {
		return null;
	}
	if (record.failure_message !== undefined && !isString(record.failure_message)) {
		return null;
	}
	if (
		record.cancellation_reason !== undefined &&
		!isString(record.cancellation_reason)
	) {
		return null;
	}
	if (record.cleanup_reason !== undefined && !isString(record.cleanup_reason)) {
		return null;
	}
	return record as TaskRecord;
};

const readTaskFile = async (filePath: string): Promise<TaskRecord | null> => {
	try {
		const raw = await fs.readFile(filePath, "utf8");
		return normalizeTaskRecord(JSON.parse(raw));
	} catch {
		return null;
	}
};

const taskFileName = (taskId: string): string => `${encodeURIComponent(taskId)}.json`;

export class TaskRegistryStore {
	private readonly tasksDir: string;

	constructor(tasksDir?: string) {
		if (tasksDir) {
			this.tasksDir = tasksDir;
			return;
		}
		const root = resolveStoragePaths().root;
		this.tasksDir = path.join(root, TASKS_DIRNAME);
	}

	private async ensureDir(): Promise<void> {
		await fs.mkdir(this.tasksDir, { recursive: true });
	}

	private taskPath(taskId: string): string {
		return path.join(this.tasksDir, taskFileName(taskId));
	}

	async list(): Promise<TaskRecord[]> {
		await this.ensureDir();
		const entries = await fs.readdir(this.tasksDir, { withFileTypes: true });
		const tasks = await Promise.all(
			entries
				.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
				.map((entry) => readTaskFile(path.join(this.tasksDir, entry.name))),
		);
		return sortByUpdatedDesc(tasks.filter((task): task is TaskRecord => task !== null));
	}

	async get(taskId: string): Promise<TaskRecord | null> {
		await this.ensureDir();
		return readTaskFile(this.taskPath(taskId));
	}

	async upsert(record: TaskRecord): Promise<void> {
		await this.ensureDir();
		await atomicWrite(
			this.taskPath(record.task_id),
			`${JSON.stringify(record, null, 2)}\n`,
		);
	}

	async patch(
		taskId: string,
		patch: Partial<Omit<TaskRecord, "version" | "task_id" | "created_at">>,
	): Promise<TaskRecord | null> {
		const current = await this.get(taskId);
		if (!current) return null;
		const next: TaskRecord = {
			...current,
			...patch,
			version: 1,
			task_id: current.task_id,
			created_at: current.created_at,
		};
		await this.upsert(next);
		return next;
	}
}
