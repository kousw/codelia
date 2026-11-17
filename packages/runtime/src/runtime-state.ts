import crypto from "node:crypto";
import type {
	Agent,
	ContentPart,
	SessionRecord,
	Tool,
	ToolContext,
	ToolDefinition,
} from "@codelia/core";
import type {
	RpcResponse,
	TaskSpawnParams,
	UiCapabilities,
	UiContextUpdateParams,
} from "@codelia/protocol";
import type {
	ApprovalMode,
	ModelFastMode,
	SkillCatalog,
} from "@codelia/shared-types";
import type { TaskRecord } from "@codelia/storage";
import type { AgentsResolver } from "./agents";
import type { AttachmentTransferService } from "./attachments/service";
import {
	type EffectiveRuntimeEnvironment,
	type RuntimeOptions,
	resolveRuntimeEnvironment,
} from "./environment";
import type { SkillsResolver } from "./skills";

export type RuntimeModelSource = "config" | "session";

export type RuntimeModelOverride = {
	provider?: string;
	name?: string;
	reasoning?: string;
	fast?: ModelFastMode;
};

export type PendingRunSteer = {
	steer_id: string;
	client_steer_id?: string;
	content: string | ContentPart[];
};

export class RuntimeState {
	attachments?: AttachmentTransferService;
	canReadAttachment?: (attachmentId: string) => boolean;
	subagentMessages?: (
		sessionId: string,
		signal?: AbortSignal,
	) => Promise<string[]>;
	subagentSpawn?: (
		params: TaskSpawnParams,
		ctx: ToolContext,
	) => Promise<TaskRecord>;
	effectiveEnvironment: EffectiveRuntimeEnvironment =
		resolveRuntimeEnvironment();
	private runSeq = new Map<string, number>();
	private runSteerCounter = 0;
	private readonly pendingSteersByRun = new Map<string, PendingRunSteer[]>();
	private readonly steerClosedRuns = new Set<string>();
	private uiRequestCounter = 0;
	private readonly pendingUiRequests = new Map<
		string,
		{
			resolve: (value: unknown) => void;
			reject: (error: Error) => void;
			timeout?: NodeJS.Timeout;
		}
	>();
	activeRunId: string | null = null;
	activeRunSignal?: AbortSignal;
	cancelRequested = false;
	lastUiContext: UiContextUpdateParams | null = null;
	lastContextLeftPercent: number | null = null;
	lastClientInfo: { name: string; version: string } | null = null;
	uiCapabilities: UiCapabilities | null = null;
	systemPrompt: string | null = null;
	executionEnvironmentContext: string | null = null;
	executionEnvironmentDebugLogged = false;
	toolDefinitions: ToolDefinition[] | null = null;
	tools: Tool[] | null = null;
	autoApprovedClientToolNames = new Set<string>();
	sessionId: string | null = null;
	sessionMeta: Record<string, unknown> | null = null;
	sessionAppend: ((record: SessionRecord) => void) | null = null;
	agent: Agent | null = null;
	cachedAuthProviders: ReadonlySet<string> = new Set();
	/** Set when a cache invalidation was requested during a run; applied at finishRun. */
	pendingAgentInvalidation = false;
	private admissionQueue: Promise<void> = Promise.resolve();
	prepareRunImages?: (
		input: string | ContentPart[],
	) => Promise<string | ContentPart[]>;
	agentsResolver: AgentsResolver | null = null;
	skillsResolver: SkillsResolver | null = null;
	skillsCatalogByCwd = new Map<string, SkillCatalog>();
	loadedSkillVersions = new Map<string, number>();
	runtimeWorkingDir: string | null = null;
	runtimeSandboxRoot: string | null = null;
	approvalMode: ApprovalMode | null = null;
	currentModelProvider: string | null = null;
	currentModelName: string | null = null;
	currentModelSource: RuntimeModelSource | null = null;
	sessionModelOverride: RuntimeModelOverride | null = null;
	diagnosticsEnabled = false;

	setRuntimeEnvironment(options: RuntimeOptions): void {
		this.effectiveEnvironment = resolveRuntimeEnvironment(options);
	}

	nextRunId(): string {
		return crypto.randomUUID();
	}

	nextSessionId(): string {
		return crypto.randomUUID();
	}

	beginRun(runId: string, uiContext?: UiContextUpdateParams | null): void {
		this.activeRunId = runId;
		this.cancelRequested = false;
		this.lastContextLeftPercent = null;
		this.steerClosedRuns.delete(runId);
		if (uiContext) {
			this.lastUiContext = uiContext;
		}
		this.runSeq.set(runId, 0);
	}

	finishRun(runId: string): void {
		if (this.activeRunId === runId) {
			this.activeRunId = null;
			this.activeRunSignal = undefined;
		}
		this.cancelRequested = false;
		this.lastContextLeftPercent = null;
		this.autoApprovedClientToolNames.clear();
		this.runSeq.delete(runId);
		this.pendingSteersByRun.delete(runId);
		this.steerClosedRuns.delete(runId);
		if (this.activeRunId === null) {
			this.sessionAppend = null;
			if (this.pendingAgentInvalidation) this.invalidateAgentCache();
		}
	}

	closeRunSteers(runId: string): void {
		this.steerClosedRuns.add(runId);
	}

	canSteerRun(runId: string): boolean {
		return (
			this.activeRunId === runId &&
			!this.cancelRequested &&
			!this.steerClosedRuns.has(runId)
		);
	}

	enqueueRunSteer(
		runId: string,
		content: string | ContentPart[],
		clientSteerId?: string,
	): string {
		this.runSteerCounter += 1;
		const steerId = `s${this.runSteerCounter}`;
		const queue = this.pendingSteersByRun.get(runId) ?? [];
		queue.push({
			steer_id: steerId,
			...(clientSteerId ? { client_steer_id: clientSteerId } : {}),
			content,
		});
		this.pendingSteersByRun.set(runId, queue);
		return steerId;
	}

	drainRunSteers(runId: string): PendingRunSteer[] {
		const queue = this.pendingSteersByRun.get(runId);
		if (!queue || queue.length === 0) {
			return [];
		}
		this.pendingSteersByRun.delete(runId);
		return queue;
	}

	/**
	 * Serializes run admission (up to `beginRun`) with idle-only management
	 * writes, so a write that saw no active run finishes before a run is admitted.
	 */
	withAdmissionLock<T>(fn: () => Promise<T>): Promise<T> {
		const next = this.admissionQueue.then(fn, fn);
		this.admissionQueue = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	/** Drops the cached agent/tools; the next run rebuilds them and restores the session. */
	invalidateAgentCache(): void {
		this.agent = null;
		this.canReadAttachment = undefined;
		this.tools = null;
		this.toolDefinitions = null;
		this.cachedAuthProviders = new Set();
		this.pendingAgentInvalidation = false;
	}

	/** Invalidates now when idle, otherwise after the active run finishes. */
	requestAgentInvalidation(): void {
		if (this.activeRunId) this.pendingAgentInvalidation = true;
		else this.invalidateAgentCache();
	}

	cancelRun(runId: string): boolean {
		if (this.activeRunId && this.activeRunId === runId) {
			this.cancelRequested = true;
			return true;
		}
		return false;
	}

	shouldSuppressEvent(runId: string): boolean {
		return this.cancelRequested && this.activeRunId === runId;
	}

	nextSequence(runId: string): number {
		const seq = this.runSeq.get(runId) ?? 0;
		this.runSeq.set(runId, seq + 1);
		return seq;
	}

	updateUiContext(params: UiContextUpdateParams): void {
		this.lastUiContext = params;
	}

	setUiCapabilities(capabilities?: UiCapabilities): void {
		this.uiCapabilities = capabilities ?? null;
	}

	nextUiRequestId(): string {
		this.uiRequestCounter += 1;
		return `ui_${this.uiRequestCounter}`;
	}

	waitForUiResponse<T>(
		id: string,
		timeoutMs?: number,
		onTimeout?: () => void,
	): Promise<T> {
		return new Promise((resolve, reject) => {
			const resolveUnknown = (value: unknown) => resolve(value as T);
			const timeout = timeoutMs
				? setTimeout(() => {
						try {
							onTimeout?.();
						} finally {
							this.pendingUiRequests.delete(id);
							reject(new Error("ui request timed out"));
						}
					}, timeoutMs)
				: undefined;
			this.pendingUiRequests.set(id, {
				resolve: resolveUnknown,
				reject,
				timeout,
			});
		});
	}

	resolveUiResponse(message: RpcResponse): boolean {
		const pending = this.pendingUiRequests.get(message.id);
		if (!pending) return false;
		if (pending.timeout) clearTimeout(pending.timeout);
		this.pendingUiRequests.delete(message.id);
		if (message.error) {
			pending.reject(new Error(message.error.message));
		} else {
			pending.resolve(message.result);
		}
		return true;
	}

	updateContextLeftPercent(value: number | null): boolean {
		if (value === null || value === this.lastContextLeftPercent) {
			return false;
		}
		this.lastContextLeftPercent = value;
		return true;
	}

	updateSkillsSnapshot(
		cwd: string,
		snapshot: {
			catalog: SkillCatalog;
			loaded_versions: Array<{ path: string; mtime_ms: number }>;
		},
	): void {
		this.skillsCatalogByCwd.set(cwd, snapshot.catalog);
		this.loadedSkillVersions = new Map(
			snapshot.loaded_versions.map((entry) => [entry.path, entry.mtime_ms]),
		);
	}
}
