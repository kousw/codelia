import { Agent, type SessionState, type Tool } from "@codelia/core";
import { createLLMWithSettings, loadSystemPrompt } from "../config/config";
import {
	cleanupExpiredSandboxDirs,
	createSandboxKey,
	parseSandboxTtlMs,
	resolveSandboxRoot,
	SandboxContext,
} from "../runtime/sandbox";
import { createTools } from "../runtime/tools";
import type { SessionManagerLike } from "../sessions/session-manager";
import type { SettingsStoreLike } from "../settings/settings-store";

type PoolEntry = {
	agent: Agent;
	sandbox: SandboxContext;
	tools: Tool[];
	lastAccess: number;
	activeRuns: number;
	abortController: AbortController | null;
	runLock: Promise<void>;
};

const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export class AgentPool {
	private readonly entries = new Map<string, PoolEntry>();
	private readonly sessionManager: SessionManagerLike;
	private readonly settingsStore: SettingsStoreLike;
	private readonly sandboxRoot: string;
	private readonly sandboxTtlMs: number;
	private sandboxCleanupInFlight = false;
	private evictTimer: ReturnType<typeof setInterval> | null = null;

	constructor(
		sessionManager: SessionManagerLike,
		settingsStore: SettingsStoreLike,
	) {
		this.sessionManager = sessionManager;
		this.settingsStore = settingsStore;
		this.sandboxRoot = resolveSandboxRoot(process.env.CODELIA_SANDBOX_ROOT);
		this.sandboxTtlMs = parseSandboxTtlMs();
		void this.cleanupSandboxDirs();
		this.evictTimer = setInterval(() => {
			this.evictStale();
			void this.cleanupSandboxDirs();
		}, 60_000);
	}

	async getOrCreate(sessionId: string): Promise<PoolEntry> {
		const existing = this.entries.get(sessionId);
		if (existing) {
			existing.lastAccess = Date.now();
			void existing.sandbox.touch();
			return existing;
		}

		const sandbox = await SandboxContext.create(sessionId, this.sandboxRoot);
		const sandboxKey = createSandboxKey(sandbox);
		const tools = createTools(sandboxKey);
		const systemPrompt = await loadSystemPrompt(sandbox.workingDir);
		const runtimeSettings = await this.settingsStore.getRuntimeSettings();
		runtimeSettings.onOpenAiOAuthRefresh = async (oauth) => {
			await this.settingsStore.saveOpenAiOAuth(oauth);
		};
		const { llm, modelRegistry } = await createLLMWithSettings(runtimeSettings);

		const agent = new Agent({ llm, tools, systemPrompt, modelRegistry });

		// Restore history from persisted state if available
		const state = await this.sessionManager.load(sessionId);
		if (state?.messages?.length) {
			agent.replaceHistoryMessages(state.messages);
		}

		const entry: PoolEntry = {
			agent,
			sandbox,
			tools,
			lastAccess: Date.now(),
			activeRuns: 0,
			abortController: null,
			runLock: Promise.resolve(),
		};
		this.entries.set(sessionId, entry);
		return entry;
	}

	private async cleanupSandboxDirs(): Promise<void> {
		if (this.sandboxCleanupInFlight) return;
		this.sandboxCleanupInFlight = true;
		try {
			const activeDirNames = new Set<string>();
			for (const entry of this.entries.values()) {
				activeDirNames.add(entry.sandbox.sessionDirName);
			}
			const result = await cleanupExpiredSandboxDirs(
				this.sandboxRoot,
				this.sandboxTtlMs,
				activeDirNames,
			);
			if (result.removed > 0 || result.errors > 0) {
				console.log(
					`[agent-pool] sandbox cleanup removed=${result.removed} errors=${result.errors}`,
				);
			}
		} catch (error) {
			console.warn(`[agent-pool] sandbox cleanup failed: ${String(error)}`);
		} finally {
			this.sandboxCleanupInFlight = false;
		}
	}

	async runWithLock<T>(
		sessionId: string,
		fn: (entry: PoolEntry) => Promise<T>,
	): Promise<T> {
		const entry = await this.getOrCreate(sessionId);
		entry.activeRuns += 1;
		entry.lastAccess = Date.now();
		void entry.sandbox.touch();
		let resolve = () => {};
		const prev = entry.runLock;
		entry.runLock = new Promise<void>((r) => {
			resolve = r;
		});
		await prev;
		try {
			return await fn(entry);
		} finally {
			entry.activeRuns = Math.max(0, entry.activeRuns - 1);
			entry.lastAccess = Date.now();
			void entry.sandbox.touch();
			resolve();
		}
	}

	cancelRun(sessionId: string): boolean {
		const entry = this.entries.get(sessionId);
		if (!entry?.abortController) return false;
		entry.abortController.abort(new Error("cancelled by user"));
		entry.abortController = null;
		return true;
	}

	async saveSession(sessionId: string): Promise<void> {
		const entry = this.entries.get(sessionId);
		if (!entry) return;
		const messages = entry.agent.getHistoryMessages();
		const state: SessionState = {
			schema_version: 1,
			session_id: sessionId,
			updated_at: new Date().toISOString(),
			messages,
		};
		await this.sessionManager.save(state);
	}

	invalidateAll(reason: string): void {
		console.log(`[agent-pool] invalidating all entries: ${reason}`);
		for (const entry of this.entries.values()) {
			entry.abortController?.abort(new Error(reason));
		}
		this.entries.clear();
	}

	private evictStale(): void {
		const now = Date.now();
		for (const [id, entry] of this.entries) {
			if (
				now - entry.lastAccess > IDLE_TIMEOUT_MS &&
				!entry.abortController &&
				entry.activeRuns === 0
			) {
				this.entries.delete(id);
			}
		}
	}

	dispose(): void {
		if (this.evictTimer) {
			clearInterval(this.evictTimer);
			this.evictTimer = null;
		}
		for (const entry of this.entries.values()) {
			entry.abortController?.abort(new Error("server shutdown"));
		}
		this.entries.clear();
	}
}
