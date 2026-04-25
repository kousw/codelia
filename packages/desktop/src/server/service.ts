import { promises as fs } from "node:fs";
import path from "node:path";
import type {
	ContextInspectResult,
	McpListResult,
	ModelListResult,
	RpcMessage,
	RpcNotification,
	RpcRequest,
	RunDiagnosticsNotify,
	RunStartResult,
	ShellExecResult,
	SkillsListResult,
	UiConfirmResult,
	UiPickResult,
	UiPromptResult,
} from "../../../protocol/src/index";
import type { AgentEvent } from "../../../shared-types/src/index";
import { SessionStateStoreImpl } from "../../../storage/src/index";
import {
	type HistoryMessage,
	restoreMessagesFromHistory,
} from "../shared/history";
import { clampSidebarWidth } from "../shared/layout";
import type {
	ChatMessage,
	DesktopSession,
	DesktopSnapshot,
	DesktopUiPreferences,
	DesktopWorkspace,
	InspectBundle,
	RuntimeHealth,
	StreamEvent,
	StreamUiRequest,
} from "../shared/types";
import { DesktopMetadataStore } from "./desktop-store";
import { readGitStatus, switchGitBranch } from "./git-status";
import { RuntimeClient } from "./runtime-client";

type RunRecord = {
	runId: string;
	workspacePath?: string;
	sessionId?: string;
	status: "running" | "awaiting_ui" | "completed" | "error" | "cancelled";
	events: Array<{ id: number; payload: StreamEvent }>;
	nextEventId: number;
};

const MAX_COMPLETED_RUN_RECORDS = 20;
const MAX_IDLE_RUNTIME_CLIENTS = 6;
const RUNTIME_IDLE_TTL_MS = 30 * 60 * 1000;

export type RuntimeEvictionCandidate = {
	pendingRequestCount: number;
};

export const canEvictRuntimeClient = (
	client: RuntimeEvictionCandidate,
	workspaceActive: boolean,
): boolean => !workspaceActive && client.pendingRequestCount === 0;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const normalizePath = (value: string): string => path.resolve(value.trim());

const createMessageId = (() => {
	let next = 0;
	return () => `desktop-msg-${++next}-${Date.now()}`;
})();

const titleFromSummary = (
	sessionId: string,
	summary?: string,
	title?: string,
): string => {
	if (title?.trim()) return title.trim();
	if (summary?.trim()) return summary.trim().slice(0, 72);
	return `Session ${sessionId.slice(0, 8)}`;
};

export class DesktopService {
	private readonly sessionStore = new SessionStateStoreImpl();
	private readonly metadataStore = new DesktopMetadataStore();
	private readonly runtimes = new Map<string, RuntimeClient>();
	private readonly runtimeLastUsed = new Map<string, number>();
	private readonly runs = new Map<string, RunRecord>();
	private readonly requestWorkspace = new Map<string, string>();
	private readonly runtimeEntryPath: string;
	private readonly onStreamEvent?: (event: StreamEvent) => void;

	constructor(options: {
		runtimeEntryPath: string;
		onStreamEvent?: (event: StreamEvent) => void;
	}) {
		this.runtimeEntryPath = options.runtimeEntryPath;
		this.onStreamEvent = options.onStreamEvent;
	}

	private getRuntime(workspacePath: string): RuntimeClient {
		const normalized = normalizePath(workspacePath);
		this.disposeIdleRuntimes(Date.now());
		let client = this.runtimes.get(normalized);
		if (!client) {
			client = new RuntimeClient(normalized, this.runtimeEntryPath);
			client.subscribe((message) => {
				this.handleRuntimeMessage(normalized, message);
			});
			this.runtimes.set(normalized, client);
		}
		this.runtimeLastUsed.set(normalized, Date.now());
		return client;
	}

	private isWorkspaceActive(workspacePath: string): boolean {
		return [...this.runs.values()].some(
			(run) =>
				run.workspacePath === workspacePath &&
				(run.status === "running" || run.status === "awaiting_ui"),
		);
	}

	private disposeRuntime(workspacePath: string, reason: string): void {
		const client = this.runtimes.get(workspacePath);
		if (!client) {
			return;
		}
		client.dispose(reason);
		this.runtimes.delete(workspacePath);
		this.runtimeLastUsed.delete(workspacePath);
	}

	private disposeIdleRuntimes(now: number): void {
		for (const [workspacePath, lastUsed] of this.runtimeLastUsed.entries()) {
			const client = this.runtimes.get(workspacePath);
			if (!client) {
				this.runtimeLastUsed.delete(workspacePath);
				continue;
			}
			if (
				canEvictRuntimeClient(client, this.isWorkspaceActive(workspacePath)) &&
				now - lastUsed > RUNTIME_IDLE_TTL_MS
			) {
				this.disposeRuntime(workspacePath, "runtime idle timeout");
			}
		}

		const evictable = [...this.runtimeLastUsed.entries()]
			.filter(([workspacePath]) => {
				const client = this.runtimes.get(workspacePath);
				return client
					? canEvictRuntimeClient(client, this.isWorkspaceActive(workspacePath))
					: false;
			})
			.sort((a, b) => a[1] - b[1]);
		const excess = this.runtimes.size - MAX_IDLE_RUNTIME_CLIENTS;
		if (excess <= 0) {
			return;
		}
		for (const [workspacePath] of evictable.slice(0, excess)) {
			this.disposeRuntime(workspacePath, "runtime pool limit exceeded");
		}
	}

	private ensureRun(runId: string, workspacePath?: string): RunRecord {
		let run = this.runs.get(runId);
		if (!run) {
			run = {
				runId,
				workspacePath,
				status: "running",
				events: [],
				nextEventId: 0,
			};
			this.runs.set(runId, run);
		}
		if (workspacePath && !run.workspacePath) {
			run.workspacePath = workspacePath;
		}
		return run;
	}

	private pushRunEvent(
		runId: string,
		event: StreamEvent,
		workspacePath?: string,
	): void {
		const run = this.ensureRun(runId, workspacePath);
		const routedEvent = {
			...event,
			run_id: "run_id" in event ? event.run_id : runId,
			...(run.sessionId ? { session_id: run.sessionId } : {}),
			...(run.workspacePath ? { workspace_path: run.workspacePath } : {}),
		} as StreamEvent;
		run.events.push({
			id: run.nextEventId++,
			payload: routedEvent,
		});
		if (routedEvent.kind === "run.status") {
			run.status = routedEvent.status;
		}
		if (routedEvent.kind === "ui.request") {
			run.status = "awaiting_ui";
		}
		if (routedEvent.kind === "done") {
			run.status = routedEvent.status;
			this.pruneCompletedRunRecords();
		}
		this.onStreamEvent?.(routedEvent);
	}

	private pruneCompletedRunRecords(): void {
		const completed = [...this.runs.values()]
			.filter((run) => run.status !== "running" && run.status !== "awaiting_ui")
			.sort((a, b) => b.nextEventId - a.nextEventId);
		for (const run of completed.slice(MAX_COMPLETED_RUN_RECORDS)) {
			this.runs.delete(run.runId);
		}
	}

	private handleRuntimeMessage(
		workspacePath: string,
		message: RpcMessage,
	): void {
		if (!isRecord(message)) return;
		if ("method" in message && typeof message.method === "string") {
			if ("id" in message && typeof message.id === "string") {
				this.handleRuntimeRequest(workspacePath, message as RpcRequest);
				return;
			}
			this.handleRuntimeNotification(workspacePath, message as RpcNotification);
		}
	}

	private handleRuntimeNotification(
		workspacePath: string,
		message: RpcNotification,
	): void {
		const params = isRecord(message.params) ? message.params : {};
		const runId = typeof params.run_id === "string" ? params.run_id : undefined;
		if (!runId) return;

		if (
			message.method === "agent.event" &&
			typeof params.seq === "number" &&
			params.event
		) {
			this.pushRunEvent(
				runId,
				{
					kind: "agent.event",
					run_id: runId,
					seq: params.seq,
					event: params.event as AgentEvent,
				},
				workspacePath,
			);
			return;
		}

		if (message.method === "run.status" && typeof params.status === "string") {
			const status = params.status as RunRecord["status"];
			this.pushRunEvent(
				runId,
				{
					kind: "run.status",
					run_id: runId,
					status,
					message:
						typeof params.message === "string" ? params.message : undefined,
				},
				workspacePath,
			);
			if (
				status === "completed" ||
				status === "cancelled" ||
				status === "error"
			) {
				this.pushRunEvent(
					runId,
					{
						kind: "done",
						run_id: runId,
						status,
					},
					workspacePath,
				);
			}
			return;
		}

		if (
			message.method === "run.context" &&
			typeof params.context_left_percent === "number"
		) {
			this.pushRunEvent(
				runId,
				{
					kind: "run.context",
					run_id: runId,
					context_left_percent: params.context_left_percent,
				},
				workspacePath,
			);
			return;
		}

		if (message.method === "run.diagnostics") {
			this.pushRunEvent(
				runId,
				{
					kind: "run.diagnostics",
					run_id: runId,
					params: params as unknown as RunDiagnosticsNotify,
				},
				workspacePath,
			);
		}
	}

	private handleRuntimeRequest(
		workspacePath: string,
		message: RpcRequest,
	): void {
		if (
			message.method !== "ui.confirm.request" &&
			message.method !== "ui.prompt.request" &&
			message.method !== "ui.pick.request"
		) {
			return;
		}
		const params = isRecord(message.params) ? message.params : {};
		const runId = typeof params.run_id === "string" ? params.run_id : undefined;
		if (!runId) return;
		this.requestWorkspace.set(message.id, workspacePath);
		if (message.method === "ui.confirm.request") {
			this.pushRunEvent(
				runId,
				{
					kind: "ui.request",
					run_id: runId,
					request_id: message.id,
					method: "ui.confirm.request",
					params: params as StreamUiRequest["params"] & {
						title: string;
						message: string;
					},
				},
				workspacePath,
			);
			return;
		}
		if (message.method === "ui.prompt.request") {
			this.pushRunEvent(
				runId,
				{
					kind: "ui.request",
					run_id: runId,
					request_id: message.id,
					method: "ui.prompt.request",
					params: params as StreamUiRequest["params"] & {
						title: string;
						message: string;
					},
				},
				workspacePath,
			);
			return;
		}
		this.pushRunEvent(
			runId,
			{
				kind: "ui.request",
				run_id: runId,
				request_id: message.id,
				method: "ui.pick.request",
				params: params as StreamUiRequest["params"] & {
					title: string;
					items: Array<{ id: string; label: string; detail?: string }>;
				},
			},
			workspacePath,
		);
	}

	async openWorkspace(workspacePath: string): Promise<DesktopWorkspace> {
		const normalized = normalizePath(workspacePath);
		const stat = await fs.stat(normalized);
		if (!stat.isDirectory()) {
			throw new Error("workspace path must be a directory");
		}
		return this.metadataStore.touchWorkspace(normalized);
	}

	async listWorkspaces(): Promise<DesktopWorkspace[]> {
		const workspaces = await this.metadataStore.listWorkspaces();
		return Promise.all(
			workspaces.map(async (workspace) => {
				try {
					await fs.access(workspace.path);
				} catch {
					return { ...workspace, invalid: true };
				}
				const git = await readGitStatus(workspace.path);
				return {
					...workspace,
					branch: git.branch,
					is_dirty: git.isDirty,
				};
			}),
		);
	}

	async createSnapshot(
		workspacePath?: string | null,
		sessionId?: string | null,
	): Promise<DesktopSnapshot> {
		const workspaces = await this.listWorkspaces();
		const uiPreferences = await this.metadataStore.readUiPreferences();
		const selectedWorkspacePath = workspacePath
			? normalizePath(workspacePath)
			: workspaces[0]?.path;
		if (!selectedWorkspacePath) {
			return {
				workspaces,
				sessions: [],
				transcript: [],
				ui_preferences: uiPreferences,
			};
		}

		const sessions = await this.listSessionsForWorkspaces(
			workspaces.map((workspace) => workspace.path),
		);
		const workspaceEntry = workspaces.find(
			(workspace) => workspace.path === selectedWorkspacePath,
		);
		let selectedSessionId =
			sessionId === null
				? undefined
				: (sessionId ??
					workspaceEntry?.last_session_id ??
					sessions.find(
						(session) => session.workspace_path === selectedWorkspacePath,
					)?.session_id);

		if (
			selectedSessionId &&
			!sessions.some((session) => session.session_id === selectedSessionId)
		) {
			selectedSessionId = sessions.find(
				(session) => session.workspace_path === selectedWorkspacePath,
			)?.session_id;
		}

		const selectedSession = sessions.find(
			(session) => session.session_id === selectedSessionId,
		);
		const effectiveWorkspacePath =
			selectedSession?.workspace_path ?? selectedWorkspacePath;
		const transcript = selectedSessionId
			? await this.loadTranscript(selectedSessionId)
			: [];
		const runtimeHealth = await this.getRuntimeHealth(effectiveWorkspacePath);

		if (selectedSessionId) {
			await this.metadataStore.rememberLastSession(
				effectiveWorkspacePath,
				selectedSessionId,
			);
		}

		return {
			workspaces,
			selected_workspace_path: effectiveWorkspacePath,
			sessions,
			selected_session_id: selectedSessionId,
			transcript,
			runtime_health: runtimeHealth,
			ui_preferences: uiPreferences,
		};
	}

	async updateUiPreferences(
		update: DesktopUiPreferences,
	): Promise<DesktopUiPreferences> {
		return this.metadataStore.writeUiPreferences({
			...(update.sidebar_width !== undefined
				? { sidebar_width: clampSidebarWidth(update.sidebar_width) }
				: {}),
		});
	}

	async listSessions(workspacePath: string): Promise<DesktopSession[]> {
		return this.listSessionsForWorkspaces([workspacePath]);
	}

	async listSessionsForWorkspaces(
		workspacePaths: string[],
	): Promise<DesktopSession[]> {
		const normalizedWorkspaces = new Set(workspacePaths.map(normalizePath));
		const summaries = await this.sessionStore.list();
		const metadata = await this.metadataStore.listSessionEntries();
		const visibleSummaries = summaries
			.filter((summary) => {
				const metadataWorkspace = metadata[summary.session_id]?.workspace_path;
				const effectiveWorkspace = metadataWorkspace ?? summary.workspace_root;
				if (!effectiveWorkspace) return false;
				return normalizedWorkspaces.has(normalizePath(effectiveWorkspace));
			})
			.filter((summary) => !metadata[summary.session_id]?.archived);
		return visibleSummaries
			.map((summary) => {
				const metadataWorkspace = metadata[summary.session_id]?.workspace_path;
				const effectiveWorkspace =
					metadataWorkspace ??
					summary.workspace_root ??
					workspacePaths[0] ??
					"";
				const normalizedWorkspace = normalizePath(effectiveWorkspace);
				return {
					session_id: summary.session_id,
					workspace_path: normalizedWorkspace,
					title: titleFromSummary(
						summary.session_id,
						summary.last_user_message,
						metadata[summary.session_id]?.title,
					),
					updated_at: summary.updated_at,
					message_count: summary.message_count,
					last_user_message: summary.last_user_message,
					archived: metadata[summary.session_id]?.archived,
				};
			})
			.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
	}

	async updateSession(
		sessionId: string,
		update: { workspace_path?: string; title?: string; archived?: boolean },
	): Promise<void> {
		const existing = await this.metadataStore.readSessionEntry(sessionId);
		const workspacePath = update.workspace_path ?? existing?.workspace_path;
		if (!workspacePath) {
			throw new Error("workspace_path is required for session metadata");
		}
		await this.metadataStore.writeSessionEntry(sessionId, {
			workspace_path: normalizePath(workspacePath),
			...(update.title !== undefined ? { title: update.title } : {}),
			...(update.archived !== undefined ? { archived: update.archived } : {}),
		});
	}

	async loadTranscript(sessionId: string): Promise<ChatMessage[]> {
		const state = await this.sessionStore.load(sessionId);
		if (!state) return [];
		return restoreMessagesFromHistory(
			state.messages as unknown as HistoryMessage[],
			createMessageId,
		);
	}

	async startRun(input: {
		workspacePath: string;
		sessionId?: string;
		message: string;
		forceCompaction?: boolean;
	}): Promise<RunStartResult> {
		const workspacePath = normalizePath(input.workspacePath);
		await this.metadataStore.touchWorkspace(workspacePath);
		const runtime = this.getRuntime(workspacePath);
		await runtime.ensureStarted();
		await runtime.notify("ui.context.update", {
			cwd: workspacePath,
			workspace_root: workspacePath,
		});
		const result = await runtime.request<RunStartResult>("run.start", {
			input: { type: "text", text: input.message },
			...(input.sessionId ? { session_id: input.sessionId } : {}),
			...(input.forceCompaction ? { force_compaction: true } : {}),
			ui_context: {
				cwd: workspacePath,
				workspace_root: workspacePath,
			},
			meta: {
				workspace_root: workspacePath,
				client: "desktop",
			},
		});
		this.ensureRun(result.run_id, workspacePath).sessionId = result.session_id;
		if (result.session_id) {
			const titleSource = input.message.trim() || "/compact";
			await this.metadataStore.writeSessionEntry(result.session_id, {
				workspace_path: workspacePath,
				title:
					(await this.metadataStore.readSessionEntry(result.session_id))
						?.title ?? titleSource.slice(0, 72),
				archived: false,
			});
			await this.metadataStore.rememberLastSession(
				workspacePath,
				result.session_id,
			);
		}
		return result;
	}

	async execShell(input: {
		workspacePath: string;
		command: string;
	}): Promise<ShellExecResult> {
		const workspacePath = normalizePath(input.workspacePath);
		const command = input.command.trim();
		if (!command) {
			throw new Error("bang command is empty");
		}
		await this.metadataStore.touchWorkspace(workspacePath);
		const runtime = this.getRuntime(workspacePath);
		await runtime.ensureStarted();
		await runtime.notify("ui.context.update", {
			cwd: workspacePath,
			workspace_root: workspacePath,
		});
		return runtime.request<ShellExecResult>("shell.exec", {
			command,
			cwd: workspacePath,
		});
	}

	readRunEvents(
		runId: string,
		cursor = -1,
	): Array<{ id: number; payload: StreamEvent }> {
		const run = this.runs.get(runId);
		if (!run) return [];
		return run.events.filter((event) => event.id > cursor);
	}

	getRunStatus(runId: string): RunRecord["status"] | undefined {
		return this.runs.get(runId)?.status;
	}

	async cancelRun(runId: string): Promise<void> {
		const run = this.runs.get(runId);
		if (!run?.workspacePath) {
			throw new Error("run not found");
		}
		const runtime = this.getRuntime(run.workspacePath);
		await runtime.request("run.cancel", { run_id: runId });
	}

	async respondToUiRequest(
		requestId: string,
		result: UiConfirmResult | UiPromptResult | UiPickResult,
	): Promise<void> {
		const workspacePath = this.requestWorkspace.get(requestId);
		if (!workspacePath) {
			throw new Error("request not found");
		}
		const runtime = this.getRuntime(workspacePath);
		await runtime.respond(requestId, result);
		this.requestWorkspace.delete(requestId);
	}

	async getRuntimeHealth(workspacePath: string): Promise<RuntimeHealth> {
		const normalized = normalizePath(workspacePath);
		const runtime = this.getRuntime(normalized);
		const git = await readGitStatus(normalized);
		let model: ModelListResult | undefined;
		try {
			await runtime.ensureStarted();
			await runtime.notify("ui.context.update", {
				cwd: normalized,
				workspace_root: normalized,
			});
			model = await runtime.request<ModelListResult>("model.list", {
				include_details: true,
			});
		} catch {
			model = undefined;
		}
		return {
			connected: runtime.connected,
			initializing: runtime.initializing,
			last_error: runtime.error,
			model,
			branch: git.branch,
			branches: git.branches,
			is_dirty: git.isDirty,
		};
	}

	async switchBranch(workspacePath: string, branch: string): Promise<void> {
		const normalized = normalizePath(workspacePath);
		await switchGitBranch(normalized, branch);
		const runtime = this.getRuntime(normalized);
		await runtime.notify("ui.context.update", {
			cwd: normalized,
			workspace_root: normalized,
		});
	}

	async setModel(
		workspacePath: string,
		params: {
			name: string;
			provider?: string;
			reasoning?: string;
			fast?: boolean;
		},
	): Promise<void> {
		const normalized = normalizePath(workspacePath);
		const runtime = this.getRuntime(normalized);
		await runtime.ensureStarted();
		await runtime.notify("ui.context.update", {
			cwd: normalized,
			workspace_root: normalized,
		});
		await runtime.request("model.set", params);
	}

	async getInspectBundle(workspacePath: string): Promise<InspectBundle> {
		const normalized = normalizePath(workspacePath);
		const runtime = this.getRuntime(normalized);
		await runtime.ensureStarted();
		await runtime.notify("ui.context.update", {
			cwd: normalized,
			workspace_root: normalized,
		});
		const [context, mcp, skills] = await Promise.all([
			runtime.request<ContextInspectResult>("context.inspect", {
				include_skills: true,
			}),
			runtime.request<McpListResult>("mcp.list"),
			runtime.request<SkillsListResult>("skills.list", {
				cwd: normalized,
			}),
		]);
		return {
			context,
			mcp,
			skills: {
				skills: skills.skills.map((skill) => ({
					title: skill.name,
					description: skill.description,
					filePath: skill.path,
				})),
				errors: skills.errors.map((error) => ({ message: error.message })),
				truncated: skills.truncated,
			},
		};
	}

	async getSkillsBundle(
		workspacePath: string,
	): Promise<InspectBundle["skills"]> {
		const normalized = normalizePath(workspacePath);
		const runtime = this.getRuntime(normalized);
		await runtime.ensureStarted();
		await runtime.notify("ui.context.update", {
			cwd: normalized,
			workspace_root: normalized,
		});
		const skills = await runtime.request<SkillsListResult>("skills.list", {
			cwd: normalized,
		});
		return {
			skills: skills.skills.map((skill) => ({
				title: skill.name,
				description: skill.description,
				filePath: skill.path,
			})),
			errors: skills.errors.map((error) => ({ message: error.message })),
			truncated: skills.truncated,
		};
	}
}
