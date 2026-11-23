// Goals, sessions and auth (Phase 2).
import { group, invalid, type Sample, typed } from "./helpers";

const target = { session_id: "session-1", goal_id: "goal-1", revision: 2 };
const snapshot = {
	session_id: "session-1",
	goal: null,
	can_continue: false,
};
const activeGoal = {
	...target,
	objective: "Verify the result",
	status: "active",
	token_budget: null,
	tokens_used: 10,
	usage_known: true,
	activation_id: "act-1",
	automatic_runs: 0,
	created_at: "2026-11-22T00:00:00.000Z",
	updated_at: "2026-11-22T00:00:00.000Z",
};
const summary = {
	session_id: "session-1",
	updated_at: "2026-11-22T10:00:00.000Z",
	run_id: "run-1",
	message_count: 4,
	last_user_message: "fix the build",
	workspace_root: "/work",
	pinned: true,
};

export const sessionSamples: Sample[] = [
	...group("ui_to_runtime_request", "goal.get", [
		typed("by session", { session_id: "session-1" }),
		typed("unbound connection", {}),
		{
			...invalid("unknown request key", { unexpected: true }, "typed"),
			lossy: true,
		},
	]),
	...group("ui_to_runtime_request", "goal.pause", [
		typed("interrupting a run", {
			session_id: "session-1",
			goal_id: "goal-1",
			activation_id: "act-1",
			run_id: "run-1",
		}),
		invalid("missing activation", { session_id: "s", goal_id: "g" }),
		{
			...invalid(
				"unknown request key",
				{ session_id: "s", goal_id: "g", activation_id: "a", unexpected: true },
				"typed",
			),
			lossy: true,
		},
	]),
	...group("ui_to_runtime_request", "goal.resume", [
		typed("target", target),
		{
			...invalid(
				"unknown request key",
				{ ...target, unexpected: true },
				"typed",
			),
			lossy: true,
		},
	]),
	...group("ui_to_runtime_request", "goal.clear", [
		typed("target", target),
		invalid("missing revision", { session_id: "s", goal_id: "g" }),
		{
			...invalid(
				"unknown request key",
				{ ...target, unexpected: true },
				"typed",
			),
			lossy: true,
		},
	]),
	...group("ui_to_runtime_request", "goal.continue", [
		typed("offer with client tools", {
			...target,
			continuation_id: "cont-1",
			after_run_id: "run-1",
			tools: [
				{ name: "tool", description: "d", parameters: { type: "object" } },
			],
		}),
		invalid("missing continuation id", target),
		{
			...invalid(
				"unknown request key",
				{ ...target, continuation_id: "cont-1", unexpected: true },
				"typed",
			),
			lossy: true,
		},
	]),
	...group("runtime_to_ui_response", "goal.get", [
		typed("no goal", snapshot),
		invalid("missing goal", { session_id: "session-1", can_continue: false }),
	]),
	...group("runtime_to_ui_response", "goal.continue", [
		typed("started", { run_id: "run-2", session_id: "session-1" }),
		invalid("missing run id", { session_id: "session-1" }),
	]),
	...group("ui_to_runtime_request", "session.list", [
		typed("all sessions", { limit: 50, scope: "all", include_archived: true }),
		typed("defaults", {}),
		invalid("unknown scope", { scope: "everything" }, "typed"),
	]),
	...group("runtime_to_ui_response", "session.list", [
		typed("sessions", {
			sessions: [summary, { session_id: "s2", updated_at: "x" }],
			current_workspace_root: "/work",
		}),
		invalid("session without updated_at", {
			sessions: [{ session_id: "s3" }],
		}),
	]),
	...group("ui_to_runtime_request", "session.history", [
		typed("bounded", { session_id: "session-1", max_events: 500 }),
		invalid("invalid limit", { limit: "many" }),
	]),
	...group("runtime_to_ui_response", "session.history", [
		typed("restored with diff", {
			runs: 2,
			events_sent: 40,
			truncated: true,
			resume_diff: "Model changed",
		}),
		invalid("fractional count", { runs: 1.5, events_sent: 0 }),
	]),
	...group("ui_to_runtime_request", "session.open", [
		typed("open", { session_id: "session-1" }),
		invalid("missing session id", {}),
	]),
	...group("runtime_to_ui_response", "session.open", [
		typed("opened", { session_id: "session-1" }),
		invalid("missing session id", {}),
	]),
	...group("ui_to_runtime_request", "session.update", [
		typed("archive", { session_id: "session-1", archived: true }),
		invalid("missing session id", { pinned: true }),
	]),
	...group("runtime_to_ui_response", "session.update", [
		typed("archived", {
			session: { ...summary, archived_at: "2026-11-22T11:00:00.000Z" },
		}),
		invalid("missing session id", {}),
	]),
	...group("ui_to_runtime_request", "auth.logout", [
		typed("one provider", { provider: "openai", clear_session: false }),
		typed("all providers, confirmed", { confirmed: true }),
		invalid("invalid clear session", { clear_session: "yes" }),
	]),
	...group("runtime_to_ui_response", "auth.logout", [
		typed("cleared", {
			ok: true,
			auth_cleared: true,
			session_cleared: false,
			provider: "openai",
		}),
		invalid("missing session_cleared", { ok: true, auth_cleared: true }),
	]),
	...group("ui_to_runtime_request", "auth.status", [
		typed("all", {}),
		typed("one provider", { provider: "openai" }),
		invalid("invalid provider", { provider: 1 }),
	]),
	...group("runtime_to_ui_response", "auth.status", [
		typed("providers", {
			providers: [
				{
					provider: "openai",
					kind: "builtin",
					methods: ["api_key", "oauth", "device_code"],
					saved: { method: "oauth", expires_at: 1767225600000 },
					env: { name: "OPENAI_API_KEY", present: false },
					active: true,
				},
				{
					provider: "local",
					kind: "config",
					methods: ["api_key"],
					saved: null,
					env: null,
					active: false,
				},
			],
			pending_login: {
				login_id: "login-1",
				provider: "openai",
				method: "device_code",
			},
		}),
		invalid("saved credential omitted", {
			providers: [
				{
					provider: "openai",
					kind: "builtin",
					methods: [],
					env: null,
					active: true,
				},
			],
		}),
	]),
	...group("ui_to_runtime_request", "auth.login", [
		typed("api key", {
			provider: "openai",
			method: "api_key",
			api_key: "sk-test",
		}),
		typed("oauth paste", {
			provider: "openai",
			method: "oauth",
			callback: "paste",
		}),
		typed("device code", {
			provider: "openai",
			method: "device_code",
			open_browser: true,
		}),
		invalid("api key without key", { provider: "openai", method: "api_key" }),
		invalid(
			"unknown method",
			{ provider: "openai", method: "passkey" },
			"unknown",
		),
	]),
	...group("runtime_to_ui_response", "auth.login", [
		typed("completed", {
			status: "completed",
			provider: "openai",
			method: "api_key",
		}),
		typed("pending device code", {
			status: "pending",
			login_id: "login-1",
			provider: "openai",
			method: "device_code",
			verification_url: "https://example.test/device",
			user_code: "ABCD-1234",
		}),
		invalid(
			"unknown status",
			{ status: "queued", provider: "openai" },
			"unknown",
		),
		invalid("missing status", { provider: "openai", method: "api_key" }),
	]),
	...group("ui_to_runtime_request", "auth.login.complete", [
		typed("callback", {
			login_id: "login-1",
			callback_input: "code=abc&state=xyz",
		}),
		invalid("missing login id", {}),
	]),
	...group("runtime_to_ui_response", "auth.login.complete", [
		typed("accepted", { ok: true }),
		invalid("missing success state", {}),
	]),
	...group("ui_to_runtime_request", "auth.login.cancel", [
		typed("cancel", { login_id: "login-1" }),
		invalid("missing login id", {}),
	]),
	...group("runtime_to_ui_response", "auth.login.cancel", [
		typed("cancelled", { cancelled: true }),
		invalid("missing cancellation state", {}),
	]),
	...["goal.pause", "goal.resume", "goal.clear"].flatMap((method) =>
		group("runtime_to_ui_response", method, [
			typed(
				"snapshot",
				method === "goal.clear"
					? snapshot
					: {
							...snapshot,
							goal:
								method === "goal.resume"
									? activeGoal
									: { ...activeGoal, status: "paused" },
							can_continue: method === "goal.resume",
						},
			),
			invalid("missing continuation flag", {
				session_id: "session-1",
				goal: null,
			}),
		]),
	),
];
