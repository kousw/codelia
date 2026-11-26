// Runtime -> UI notifications and dialog requests (Phase 3).
import { group, invalid, type Sample, typed } from "./helpers";

const usageSummary = {
	total_calls: 2,
	total_tokens: 300,
	total_input_tokens: 200,
	total_output_tokens: 100,
	total_cached_input_tokens: 50,
	total_cache_creation_tokens: 0,
	total_cost_usd: 0.01,
	by_model: {
		"gpt-6.1-sol": {
			calls: 2,
			input_tokens: 200,
			output_tokens: 100,
			cached_input_tokens: 50,
			cache_creation_tokens: 0,
			total_tokens: 300,
		},
	},
};
const llmCall = {
	run_id: "run-1",
	seq: 1,
	provider: "openai",
	model: "gpt-6.1-sol",
	request_ts: "2026-11-22T00:00:00.000Z",
	response_ts: "2026-11-22T00:00:01.000Z",
	latency_ms: 950,
	output_tokens_per_second: 61.4,
	stop_reason: "stop",
	usage: {
		input_tokens: 100,
		output_tokens: 50,
		total_tokens: 150,
		input_cached_tokens: 20,
	},
	cache: {
		hit_state: "hit",
		cache_read_tokens: 20,
		cache_creation_tokens: 0,
		cache_read_ratio: 0.2,
	},
	cost_usd: 0.004,
};
const snapshot = {
	session_id: "session-1",
	goal: null,
	can_continue: false,
};

export const notificationSamples: Sample[] = [
	...group("runtime_to_ui_notification", "run.context", [
		typed("percent", { run_id: "run-1", context_left_percent: 72 }),
		invalid("missing percent", { run_id: "run-1" }),
	]),
	...group("runtime_to_ui_notification", "run.diagnostics", [
		typed("llm call", { run_id: "run-1", kind: "llm_call", call: llmCall }),
		typed("run summary", {
			run_id: "run-1",
			kind: "run_summary",
			summary: usageSummary,
		}),
		invalid(
			"unknown diagnostics kind",
			{ run_id: "run-1", kind: "tool_call" },
			"unknown",
		),
		invalid("llm call without cache", {
			run_id: "run-1",
			kind: "llm_call",
			call: { ...llmCall, cache: undefined },
		}),
	]),
	...group("runtime_to_ui_notification", "run.context.usage", [
		typed("usage", {
			run_id: "run-1",
			provider: "openai",
			model: "gpt-6.1-sol",
			limit_tokens: 270000,
			used_tokens: 1000,
			input_tokens: 900,
			left_percent: 99.6,
			basis: "provider",
			breakdown: [],
		}),
		invalid("missing context usage", { run_id: "run-1" }),
	]),
	...group("runtime_to_ui_notification", "goal.updated", [
		typed("snapshot", snapshot),
		invalid("missing goal snapshot", {}),
	]),
	...group("runtime_to_ui_notification", "goal.cleared", [
		typed("snapshot", snapshot),
		invalid("missing session id", {}),
	]),
	...group("runtime_to_ui_notification", "goal.ready", [
		typed("offer", {
			session_id: "session-1",
			goal_id: "goal-1",
			revision: 3,
			continuation_id: "cont-1",
			after_run_id: "run-1",
		}),
		invalid("missing continuation id", {
			session_id: "session-1",
			goal_id: "goal-1",
			revision: 3,
		}),
	]),
	...group("runtime_to_ui_notification", "auth.login.status", [
		typed("completed", {
			login_id: "login-1",
			provider: "openai",
			method: "oauth",
			status: "completed",
		}),
		invalid("missing login id", {}),
	]),
	...group("runtime_to_ui_notification", "task.progress", [
		typed("progress", {
			task_id: "task-1",
			name: "Mika",
			state: "running",
			progress: {
				step: 1,
				phase: "model",
				tool_calls: 0,
				updated_at: "2026-11-22T00:00:00.000Z",
			},
			updated_at: "2026-11-22T00:00:00.000Z",
		}),
		invalid("missing task id", {}),
	]),
	...group("runtime_to_ui_notification", "ui.pick.cancelled", [
		typed("withdrawn", { id: "ui-1" }),
		invalid("missing pick id", {}),
	]),
	...group("runtime_to_ui_request", "ui.confirm.request", [
		typed("approval with remember", {
			run_id: "run-1",
			title: "Run command?",
			message: "rm -rf build",
			confirm_label: "Run",
			danger_level: "danger",
			allow_remember: true,
			allow_reason: true,
		}),
		invalid("missing message", { title: "Run?" }),
	]),
	...group("ui_to_runtime_response", "ui.confirm.request", [
		typed("allowed and remembered", { ok: true, remember: true }),
		{
			// Older TUIs send `null` for unset fields; Rust writes them as absent.
			case: "declined with null fields",
			value: { ok: false, remember: false, reason: null },
			expect: "typed",
			ts: "valid",
			lossy: true,
		},
		invalid("missing ok", { remember: true }),
	]),
	...group("runtime_to_ui_request", "ui.prompt.request", [
		typed("secret prompt", {
			title: "API key",
			message: "Paste the key",
			secret: true,
		}),
		invalid("missing message", { title: "API key" }),
	]),
	...group("ui_to_runtime_response", "ui.prompt.request", [
		typed("value", { value: "sk-test" }),
		typed("cancelled", { value: null }),
		invalid("value omitted", {}),
	]),
	...group("runtime_to_ui_request", "ui.pick.request", [
		typed("structured approval", {
			approval: true,
			title: "Allow edit?",
			message: "src/main.rs",
			items: [
				{ id: "allow", label: "Allow" },
				{ id: "deny", label: "Deny", detail: "Stop the turn" },
			],
		}),
		typed("unsandboxed escalation approval", {
			approval: true,
			escalation: "unsandboxed",
			protected_paths_enforced: false,
			title: "Approve unsandboxed shell? (protected paths not enforced)",
			message: "Command: gh run view 1 --log-failed",
			items: [
				{ id: "r/allow_once", label: "Run once (unsandboxed)" },
				{ id: "r/deny_continue", label: "Skip" },
			],
		}),
		// Rust decodes a newer escalation kind through `Unknown`.
		invalid(
			"future escalation kind",
			{
				approval: true,
				escalation: "future_kind",
				title: "Approve?",
				items: [{ id: "a", label: "Allow" }],
			},
			"typed",
		),
		invalid("item without label", { title: "Pick", items: [{ id: "a" }] }),
	]),
	...group("ui_to_runtime_response", "ui.pick.request", [
		typed("chosen", { ids: ["allow"] }),
		typed("cancelled", { ids: [] }),
		invalid("invalid ids", { ids: [1] }),
	]),
];
