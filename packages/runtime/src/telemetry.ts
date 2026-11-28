import type {
	RunMetricsNotify,
	RuntimePerfPhase,
	TelemetryModelUsage,
	TelemetrySummary,
	ToolTimingRecord,
} from "@codelia/protocol";

const MAX_RECENT_CALLS = 64;
const MAX_RECENT_TOOLS = 64;

const cloneModelUsage = (entry: TelemetryModelUsage): TelemetryModelUsage => ({
	...entry,
});

export const createEmptyTelemetrySummary = (): TelemetrySummary => ({
	total_calls: 0,
	total_tokens: 0,
	total_input_tokens: 0,
	total_output_tokens: 0,
	total_output_reasoning_tokens: 0,
	total_cached_input_tokens: 0,
	total_cache_creation_tokens: 0,
	total_input_image_tokens: 0,
	cache_hit_calls: 0,
	cache_miss_calls: 0,
	cache_unknown_calls: 0,
	total_cost_usd: null,
	retry_count: 0,
	retry_wait_ms: 0,
	tool_calls: 0,
	tool_errors: 0,
	tool_exec_ms: 0,
	tool_approval_wait_ms: 0,
	compaction_count: 0,
	compaction_duration_ms: 0,
	by_model: {},
});

export const cloneTelemetrySummary = (
	summary: TelemetrySummary,
): TelemetrySummary => ({
	...summary,
	by_model: Object.fromEntries(
		Object.entries(summary.by_model).map(([model, entry]) => [
			model,
			cloneModelUsage(entry),
		]),
	),
});

const applyCallToSummary = (
	summary: TelemetrySummary,
	call: RunMetricsNotify,
): void => {
	const usage = call.usage ?? null;
	const inputTokens = usage?.input_tokens ?? 0;
	const outputTokens = usage?.output_tokens ?? 0;
	const reasoningTokens = usage?.output_reasoning_tokens ?? 0;
	const cachedTokens = usage?.input_cached_tokens ?? 0;
	const cacheCreationTokens = usage?.input_cache_creation_tokens ?? 0;
	const imageTokens = usage?.input_image_tokens ?? 0;
	const totalTokens = usage?.total_tokens ?? 0;
	const hitState =
		call.cache?.hit_state ??
		(typeof usage?.input_cached_tokens === "number"
			? cachedTokens > 0
				? "hit"
				: "miss"
			: "unknown");
	const validCost =
		typeof call.cost_usd === "number" &&
		Number.isFinite(call.cost_usd) &&
		call.cost_usd >= 0
			? call.cost_usd
			: null;

	summary.total_calls += 1;
	summary.total_tokens += totalTokens;
	summary.total_input_tokens += inputTokens;
	summary.total_output_tokens += outputTokens;
	summary.total_output_reasoning_tokens += reasoningTokens;
	summary.total_cached_input_tokens += cachedTokens;
	summary.total_cache_creation_tokens += cacheCreationTokens;
	summary.total_input_image_tokens += imageTokens;
	if (hitState === "hit") summary.cache_hit_calls += 1;
	else if (hitState === "miss") summary.cache_miss_calls += 1;
	else summary.cache_unknown_calls += 1;
	if (validCost !== null) {
		summary.total_cost_usd = (summary.total_cost_usd ?? 0) + validCost;
	}

	const modelKey = call.model ?? "unknown";
	const existing = summary.by_model[modelKey];
	if (!existing) {
		summary.by_model[modelKey] = {
			calls: 1,
			input_tokens: inputTokens,
			output_tokens: outputTokens,
			output_reasoning_tokens: reasoningTokens,
			cached_input_tokens: cachedTokens,
			cache_creation_tokens: cacheCreationTokens,
			input_image_tokens: imageTokens,
			cache_hit_calls: hitState === "hit" ? 1 : 0,
			cache_miss_calls: hitState === "miss" ? 1 : 0,
			cache_unknown_calls: hitState === "unknown" ? 1 : 0,
			total_tokens: totalTokens,
			cost_usd: validCost,
		};
	} else {
		existing.calls += 1;
		existing.input_tokens += inputTokens;
		existing.output_tokens += outputTokens;
		existing.output_reasoning_tokens += reasoningTokens;
		existing.cached_input_tokens += cachedTokens;
		existing.cache_creation_tokens += cacheCreationTokens;
		existing.input_image_tokens += imageTokens;
		if (hitState === "hit") existing.cache_hit_calls += 1;
		else if (hitState === "miss") existing.cache_miss_calls += 1;
		else existing.cache_unknown_calls += 1;
		existing.total_tokens += totalTokens;
		if (validCost !== null) {
			existing.cost_usd = (existing.cost_usd ?? 0) + validCost;
		}
	}
};

const applyToolToSummary = (
	summary: TelemetrySummary,
	record: ToolTimingRecord,
): void => {
	summary.tool_calls += 1;
	if (record.status === "error") {
		summary.tool_errors += 1;
	}
	summary.tool_exec_ms += Math.max(
		0,
		record.exec_duration_ms ?? record.duration_ms,
	);
	summary.tool_approval_wait_ms += Math.max(0, record.approval_wait_ms ?? 0);
};

const applyRetryToSummary = (
	summary: TelemetrySummary,
	delayMs: number,
): void => {
	summary.retry_count += 1;
	summary.retry_wait_ms += Math.max(0, Math.round(delayMs));
};

const applyCompactionToSummary = (
	summary: TelemetrySummary,
	durationMs: number,
): void => {
	summary.compaction_count += 1;
	summary.compaction_duration_ms += Math.max(0, durationMs);
};

/**
 * Session-scoped in-memory telemetry & runtime perf store.
 * Survives `invalidateAgentCache()` and resets only when switching sessions.
 */
export class RuntimeTelemetryStore {
	private sessionSummary: TelemetrySummary = createEmptyTelemetrySummary();
	private currentRunId: string | null = null;
	private currentRunSummary: TelemetrySummary | null = null;
	private readonly recentCalls: RunMetricsNotify[] = [];
	private readonly recentTools: ToolTimingRecord[] = [];
	private startupPhases: RuntimePerfPhase[] = [];
	private agentInitPhases: RuntimePerfPhase[] = [];

	resetSession(): void {
		this.sessionSummary = createEmptyTelemetrySummary();
		this.currentRunId = null;
		this.currentRunSummary = null;
		this.recentCalls.length = 0;
		this.recentTools.length = 0;
	}

	beginRun(runId: string): void {
		this.currentRunId = runId;
		this.currentRunSummary = createEmptyTelemetrySummary();
	}

	recordLlmCall(call: RunMetricsNotify): void {
		applyCallToSummary(this.sessionSummary, call);
		if (this.currentRunId === call.run_id && this.currentRunSummary) {
			applyCallToSummary(this.currentRunSummary, call);
		}
		// Keep `recent_calls` compact without embedding nested session snapshots.
		const { session: _session, ...callRecord } = call;
		this.recentCalls.push(callRecord);
		if (this.recentCalls.length > MAX_RECENT_CALLS) {
			this.recentCalls.shift();
		}
	}

	recordToolComplete(record: ToolTimingRecord): void {
		applyToolToSummary(this.sessionSummary, record);
		if (this.currentRunId === record.run_id && this.currentRunSummary) {
			applyToolToSummary(this.currentRunSummary, record);
		}
		this.recentTools.push(record);
		if (this.recentTools.length > MAX_RECENT_TOOLS) {
			this.recentTools.shift();
		}
	}

	recordRetry(runId: string, delayMs: number): void {
		applyRetryToSummary(this.sessionSummary, delayMs);
		if (this.currentRunId === runId && this.currentRunSummary) {
			applyRetryToSummary(this.currentRunSummary, delayMs);
		}
	}

	recordCompaction(runId: string, durationMs: number): void {
		applyCompactionToSummary(this.sessionSummary, durationMs);
		if (this.currentRunId === runId && this.currentRunSummary) {
			applyCompactionToSummary(this.currentRunSummary, durationMs);
		}
	}

	recordStartupPhase(name: string, durationMs: number): void {
		this.startupPhases.push({
			name,
			duration_ms: Math.max(0, Math.round(durationMs)),
		});
	}

	setAgentInitPhases(phases: RuntimePerfPhase[]): void {
		this.agentInitPhases = phases.map((phase) => ({
			name: phase.name,
			duration_ms: Math.max(0, Math.round(phase.duration_ms)),
		}));
	}

	getSessionSummary(): TelemetrySummary {
		return cloneTelemetrySummary(this.sessionSummary);
	}

	getRunSummary(): TelemetrySummary | null {
		return this.currentRunSummary
			? cloneTelemetrySummary(this.currentRunSummary)
			: null;
	}

	getRecentCalls(): RunMetricsNotify[] {
		return this.recentCalls.slice();
	}

	getRecentTools(): ToolTimingRecord[] {
		return this.recentTools.slice();
	}

	getStartupPhases(): RuntimePerfPhase[] {
		return this.startupPhases.slice();
	}

	getAgentInitPhases(): RuntimePerfPhase[] {
		return this.agentInitPhases.slice();
	}
}
