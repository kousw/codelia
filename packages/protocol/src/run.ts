import type { AgentEvent } from "@codelia/shared-types";
import type { UiContextSnapshot } from "./ui-context";

export type RunInputText = { type: "text"; text: string };

export type RunInputTextPart = {
	type: "text";
	text: string;
};

export type RunInputImagePart = {
	type: "image_url";
	image_url: {
		url: string;
		detail?: "auto" | "low" | "high";
		media_type?: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
	};
};

export type RunInputParts = {
	type: "parts";
	parts: Array<RunInputTextPart | RunInputImagePart>;
};

export type RunInput = RunInputText | RunInputParts;

export type RunStartParams = {
	input: RunInput;
	session_id?: string;
	force_compaction?: boolean;
	ui_context?: UiContextSnapshot;
	meta?: Record<string, unknown>;
};

export type RunStartResult = {
	run_id: string;
};

export type AgentEventNotify = {
	run_id: string;
	seq: number;
	event: AgentEvent;
	meta?: Record<string, unknown>;
};

export type RunCancelParams = {
	run_id: string;
	reason?: string;
};

export type RunStatus =
	| "running"
	| "awaiting_ui"
	| "completed"
	| "error"
	| "cancelled";

export type RunStatusNotify = {
	run_id: string;
	status: RunStatus;
	message?: string;
};

export type RunContextNotify = {
	run_id: string;
	context_left_percent: number;
};

export type RunUsageSummary = {
	total_calls: number;
	total_tokens: number;
	total_input_tokens: number;
	total_output_tokens: number;
	total_cached_input_tokens: number;
	total_cache_creation_tokens: number;
	total_cost_usd?: number | null;
	by_model: Record<
		string,
		{
			calls: number;
			input_tokens: number;
			output_tokens: number;
			cached_input_tokens: number;
			cache_creation_tokens: number;
			total_tokens: number;
			cost_usd?: number | null;
		}
	>;
};

export type CacheHitState = "hit" | "miss" | "unknown";

export type LlmCallDiagnostics = {
	run_id: string;
	seq: number;
	provider?: string;
	model: string;
	request_ts: string;
	response_ts: string;
	latency_ms: number;
	stop_reason?: string | null;
	usage?: {
		input_tokens: number;
		output_tokens: number;
		total_tokens: number;
		input_cached_tokens?: number | null;
		input_cache_creation_tokens?: number | null;
		input_image_tokens?: number | null;
	} | null;
	cache: {
		hit_state: CacheHitState;
		cache_read_tokens: number;
		cache_creation_tokens: number;
		cache_read_ratio?: number | null;
	};
	cost_usd?: number | null;
	provider_meta_summary?: string | null;
};

export type RunDiagnosticsNotify =
	| {
			run_id: string;
			kind: "llm_call";
			call: LlmCallDiagnostics;
	  }
	| {
			run_id: string;
			kind: "run_summary";
			summary: RunUsageSummary;
	  };
