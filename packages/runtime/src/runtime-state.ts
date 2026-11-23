import crypto from "node:crypto";
import { realpathSync } from "node:fs";
import type {
	Agent,
	ContentPart,
	ConversationApprovalContext,
	ConversationApprovalScope,
	SessionRecord,
	Tool,
	ToolContext,
	ToolDefinition,
} from "@codelia/core";
import type {
	RpcResponse,
	SandboxGetResult,
	TaskSpawnParams,
	UiCapabilities,
	UiContextUpdateParams,
} from "@codelia/protocol";
import type {
	ApprovalMode,
	ModelFastMode,
	SandboxMode,
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
import type { ApprovalAudit } from "./permissions/dispatch";
import type { ApprovalReceiptScope } from "./permissions/request-receipts";
import type {
	ReviewHistoryReferences,
	ReviewUserText,
} from "./permissions/review-evidence";

export type ApprovalScope = "session" | "workspace";

import { defaultSandboxMode } from "./sandbox/mode";
import type { SkillsResolver } from "./skills";

export type RuntimeModelSource = "config" | "session";

type RuntimeChatRoute =
	| { kind: "builtin"; provider: string; apiBase?: string }
	| { kind: "named" };

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

type ReadApprovalHistory = (
	references: ReviewHistoryReferences,
	scope: ConversationApprovalScope,
) => Promise<ConversationApprovalContext | null>;

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
	private appliedApprovalSteers = 0;
	approvalConnectionGeneration = 0;
	approvalAuthorityGeneration = 0;
	private workspaceApprovalAuthorityGeneration = 0;
	private approvalChanges = new AbortController();
	private workspaceApprovalChanges = new AbortController();
	private receiptConnection = new AbortController();
	private receiptOwner = new AbortController();

	approvalReceiptScope(scope: ApprovalScope = "session"): ApprovalReceiptScope {
		return {
			generation: this.approvalConnectionGeneration,
			connectionSignal: this.receiptConnection.signal,
			ownerSignal:
				scope === "workspace"
					? this.receiptConnection.signal
					: this.receiptOwner.signal,
		};
	}
	private approvalIntent?: {
		runId: string;
		original: ReviewUserText;
		priorCorrections: readonly ReviewUserText[];
		earlierGoalSteers: readonly ReviewUserText[];
		steers: Array<{ id: string; text?: ReviewUserText; applied: boolean }>;
		readHistory?: ReadApprovalHistory;
	};

	approvalUserIntent(runId: string) {
		const intent = this.approvalIntent;
		if (!intent || intent.runId !== runId) return null;
		const corrections = [...intent.priorCorrections];
		for (const steer of intent.steers) {
			if (!steer.applied || !steer.text) return null;
			corrections.push(steer.text);
		}
		return {
			original: intent.original,
			corrections,
			...(intent.earlierGoalSteers.length
				? { earlierGoalSteers: intent.earlierGoalSteers }
				: {}),
		};
	}

	async approvalUserHistory(
		runId: string,
		references: ReviewHistoryReferences,
		scope: ConversationApprovalScope,
	) {
		const intent = this.approvalIntent;
		if (intent?.runId !== runId) return null;
		return (await intent.readHistory?.(references, scope)) ?? null;
	}

	approvalSteerText(runId: string, steerId: string) {
		const intent = this.approvalIntent;
		if (intent?.runId === runId)
			return intent.steers.find((steer) => steer.id === steerId)?.text;
	}

	confirmApprovalSteer(runId: string, steerId: string): void {
		const intent = this.approvalIntent;
		if (intent?.runId !== runId) return;
		const steer = intent.steers.find((entry) => entry.id === steerId);
		if (!steer || steer.applied) return;
		steer.applied = true;
		this.appliedApprovalSteers++;
		this.signalApprovalChange();
	}

	approvalSignal(
		signal?: AbortSignal,
		scope: ApprovalScope = "session",
	): AbortSignal {
		if (scope === "workspace") {
			return AbortSignal.any([
				this.workspaceApprovalChanges.signal,
				this.receiptConnection.signal,
				...(signal ? [signal] : []),
			]);
		}
		return signal
			? AbortSignal.any([signal, this.approvalChanges.signal])
			: this.approvalChanges.signal;
	}

	approvalAuthorityRevision(scope: ApprovalScope): number {
		return scope === "workspace"
			? this.workspaceApprovalAuthorityGeneration
			: this.approvalAuthorityGeneration;
	}

	private signalApprovalChange(): void {
		this.approvalChanges.abort();
		this.approvalChanges = new AbortController();
	}

	reviseApprovalAuthority(scope: ApprovalScope = "workspace"): void {
		this.approvalAuthorityGeneration++;
		if (scope === "workspace") {
			this.workspaceApprovalAuthorityGeneration++;
			this.workspaceApprovalChanges.abort();
			this.workspaceApprovalChanges = new AbortController();
		}
		this.signalApprovalChange();
	}

	approvalContext(scope: ApprovalScope = "session"): string {
		const connection = this.approvalConnectionGeneration;
		const authority = this.approvalAuthorityRevision(scope);
		if (scope === "workspace") {
			const root = this.runtimeSandboxRoot ?? this.runtimeWorkingDir;
			return JSON.stringify([
				root === null ? null : realpathSync(root),
				this.sandboxMode.value,
				connection,
				authority,
			]);
		}
		return JSON.stringify([
			this.sessionId,
			this.activeRunId,
			this.runSteerCounter,
			this.appliedApprovalSteers,
			this.cancelRequested,
			connection,
			authority,
		]);
	}
	private readonly acceptedSteerIds = new Map<string, Map<string, string>>();
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
	wrapClientTool?: (tool: Tool) => Tool;
	wrapGoalTool?: (tool: Tool) => Tool;
	private boundSessionId: string | null = null;
	get sessionId(): string | null {
		return this.boundSessionId;
	}
	set sessionId(value: string | null) {
		if (value === this.boundSessionId) return;
		this.boundSessionId = value;
		this.receiptOwner.abort();
		this.receiptOwner = new AbortController();
		this.signalApprovalChange();
	}
	sessionMeta: Record<string, unknown> | null = null;
	sessionAppend: ((record: SessionRecord) => void) | null = null;
	recordAutoReviewFailure(entry: ApprovalAudit): void {
		const { runId, reviewDiagnostic } = entry;
		if (!runId || this.activeRunId !== runId || !reviewDiagnostic) return;
		const { code, httpStatus, location, position } = reviewDiagnostic;
		this.sessionAppend?.({
			type: "approval.review_failure",
			run_id: runId,
			ts: new Date(entry.at).toISOString(),
			request_id: entry.requestId,
			reason: entry.reason,
			code,
			...(httpStatus === undefined ? {} : { http_status: httpStatus }),
			...(location === undefined ? {} : { location }),
			...(position === undefined ? {} : { position }),
		});
	}
	private cachedAgent: Agent | null = null;
	private cachedAgentSandboxMode?: SandboxMode;
	private activeSandboxMode?: SandboxMode;
	get agent(): Agent | null {
		return this.cachedAgent;
	}
	set agent(value: Agent | null) {
		this.cachedAgent = value;
		this.cachedAgentSandboxMode = value ? this.sandboxMode.value : undefined;
	}
	get appliedSandboxMode(): SandboxGetResult["applied"] {
		if (this.activeRunId && this.activeSandboxMode)
			return { value: this.activeSandboxMode, target: "run" };
		return this.cachedAgentSandboxMode
			? { value: this.cachedAgentSandboxMode, target: "agent" }
			: null;
	}
	private readonly agentChatRoutes = new WeakMap<Agent, RuntimeChatRoute>();
	private activeReviewChatRoute?: RuntimeChatRoute;

	recordAgentChatRoute(agent: Agent, route: RuntimeChatRoute): void {
		this.agentChatRoutes.set(agent, Object.freeze(route));
	}

	get reviewChatRoute(): RuntimeChatRoute | undefined {
		if (this.activeRunId) return this.activeReviewChatRoute;
		return this.agent ? this.agentChatRoutes.get(this.agent) : undefined;
	}

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
	sandboxMode = defaultSandboxMode;
	currentModelProvider: string | null = null;
	currentModelName: string | null = null;
	currentModelSource: RuntimeModelSource | null = null;
	sessionModelOverride: RuntimeModelOverride | null = null;
	diagnosticsEnabled = false;

	setRuntimeEnvironment(options: RuntimeOptions): void {
		this.effectiveEnvironment = resolveRuntimeEnvironment(options);
		const value = this.effectiveEnvironment.workspace.sandboxMode;
		this.sandboxMode = value ? { value, source: "sdk" } : defaultSandboxMode;
	}

	nextRunId(): string {
		return crypto.randomUUID();
	}

	nextSessionId(): string {
		return crypto.randomUUID();
	}

	beginRun(
		runId: string,
		uiContext?: UiContextUpdateParams | null,
		approvalUserText?: ReviewUserText,
		agent?: Agent,
		readApprovalHistory?: ReadApprovalHistory,
		goalSteers?: {
			beforeObjective: readonly ReviewUserText[];
			afterObjective: readonly ReviewUserText[];
		},
	): void {
		this.signalApprovalChange();
		this.approvalIntent = approvalUserText
			? {
					runId,
					original: approvalUserText,
					priorCorrections: goalSteers?.afterObjective ?? [],
					earlierGoalSteers: goalSteers?.beforeObjective ?? [],
					steers: [],
					readHistory: readApprovalHistory,
				}
			: undefined;
		this.activeRunId = runId;
		this.activeSandboxMode =
			(agent === this.agent && this.cachedAgentSandboxMode) ||
			this.sandboxMode.value;
		this.activeReviewChatRoute = agent && this.agentChatRoutes.get(agent);
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
			this.signalApprovalChange();
			this.approvalIntent = undefined;
			this.activeRunId = null;
			this.activeSandboxMode = undefined;
			this.activeReviewChatRoute = undefined;
			this.activeRunSignal = undefined;
		}
		this.cancelRequested = false;
		this.lastContextLeftPercent = null;
		this.runSeq.delete(runId);
		this.pendingSteersByRun.delete(runId);
		this.acceptedSteerIds.delete(runId);
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

	acceptedRunSteerId(runId: string, clientSteerId: string): string | undefined {
		return this.acceptedSteerIds.get(runId)?.get(clientSteerId);
	}

	enqueueRunSteer(
		runId: string,
		content: string | ContentPart[],
		clientSteerId?: string,
		approvalUserText?: ReviewUserText,
	): string {
		this.signalApprovalChange();
		this.runSteerCounter += 1;
		const steerId = `s${this.runSteerCounter}`;
		if (clientSteerId !== undefined) {
			const accepted =
				this.acceptedSteerIds.get(runId) ?? new Map<string, string>();
			accepted.set(clientSteerId, steerId);
			this.acceptedSteerIds.set(runId, accepted);
		}
		if (this.approvalIntent?.runId === runId) {
			this.approvalIntent.steers.push({
				id: steerId,
				text: approvalUserText,
				applied: false,
			});
		}
		const queue = this.pendingSteersByRun.get(runId) ?? [];
		queue.push({
			steer_id: steerId,
			...(clientSteerId !== undefined
				? { client_steer_id: clientSteerId }
				: {}),
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
	invalidateAgentCache(scope: ApprovalScope = "workspace"): void {
		this.reviseApprovalAuthority(scope);
		this.agent = null;
		this.subagentSpawn = undefined;
		this.canReadAttachment = undefined;
		this.tools = null;
		this.wrapClientTool = undefined;
		this.wrapGoalTool = undefined;
		this.toolDefinitions = null;
		this.cachedAuthProviders = new Set();
		this.pendingAgentInvalidation = false;
	}

	/** Invalidates now when idle, otherwise after the active run finishes. */
	requestAgentInvalidation(): void {
		if (this.activeRunId) {
			this.reviseApprovalAuthority();
			this.pendingAgentInvalidation = true;
		} else this.invalidateAgentCache();
	}

	cancelRun(runId: string): boolean {
		if (this.activeRunId && this.activeRunId === runId) {
			this.signalApprovalChange();
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
		this.signalApprovalChange();
		this.receiptConnection.abort();
		this.receiptConnection = new AbortController();
		this.receiptOwner.abort();
		this.receiptOwner = new AbortController();
		this.approvalConnectionGeneration++;
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
