import crypto from "node:crypto";
import type { Agent, SessionRecord, Tool, ToolDefinition } from "@codelia/core";
import type {
	RpcResponse,
	UiCapabilities,
	UiContextUpdateParams,
} from "@codelia/protocol";
import type { SkillCatalog } from "@codelia/shared-types";
import type { AgentsResolver } from "./agents";
import type { SkillsResolver } from "./skills";

export class RuntimeState {
	private runSeq = new Map<string, number>();
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
	cancelRequested = false;
	lastUiContext: UiContextUpdateParams | null = null;
	lastContextLeftPercent: number | null = null;
	lastClientInfo: { name: string; version: string } | null = null;
	uiCapabilities: UiCapabilities | null = null;
	systemPrompt: string | null = null;
	toolDefinitions: ToolDefinition[] | null = null;
	tools: Tool[] | null = null;
	sessionId: string | null = null;
	sessionAppend: ((record: SessionRecord) => void) | null = null;
	agent: Agent | null = null;
	agentsResolver: AgentsResolver | null = null;
	skillsResolver: SkillsResolver | null = null;
	skillsCatalogByCwd = new Map<string, SkillCatalog>();
	loadedSkillVersions = new Map<string, number>();
	runtimeWorkingDir: string | null = null;
	runtimeSandboxRoot: string | null = null;

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
		if (uiContext) {
			this.lastUiContext = uiContext;
		}
		this.runSeq.set(runId, 0);
	}

	finishRun(runId: string): void {
		if (this.activeRunId === runId) {
			this.activeRunId = null;
		}
		this.cancelRequested = false;
		this.lastContextLeftPercent = null;
		this.runSeq.delete(runId);
		if (this.activeRunId === null) {
			this.sessionAppend = null;
		}
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

	waitForUiResponse<T>(id: string, timeoutMs?: number): Promise<T> {
		return new Promise((resolve, reject) => {
			const resolveUnknown = (value: unknown) => resolve(value as T);
			const timeout = timeoutMs
				? setTimeout(() => {
						this.pendingUiRequests.delete(id);
						reject(new Error("ui request timed out"));
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
