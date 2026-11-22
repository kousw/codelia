import { event, group, invalid, typed, type Sample } from "./helpers";

export const coreSamples: Sample[] = [
	...group("ui_to_runtime_request", "initialize", [
		typed("tui initialize", {
			protocol_version: "0",
			client: { name: "codelia-tui", version: "0.1.0" },
			ui_capabilities: {
				supports_confirm: true,
				supports_prompt: true,
				supports_pick: true,
				supports_structured_approval: true,
				supports_permission_preflight_events: true,
				supports_text_delta: true,
				supports_goals: true,
			},
		}),
		typed("initialize without ui capabilities", {
			protocol_version: "0",
			client: { name: "client", version: "1" },
		}),
		// Embedded hosts and older clients send partial params.
		typed("initialize with empty params", {}),
		invalid("initialize with a non-object client", {
			protocol_version: "0",
			client: "tui",
		}),
		// Rust types do not enforce string constants; the runtime rejects it.
		invalid(
			"initialize with another protocol version",
			{ protocol_version: "1", client: { name: "client", version: "1" } },
			"typed",
		),
	]),
	...group("ui_to_runtime_request", "theme.set", [
		typed("theme name", { name: "ocean" }),
		invalid("theme name is not a string", { name: 42 }),
	]),
	...group("ui_to_runtime_request", "goal.set", [
		typed("objective without budget keeps the budget", {
			objective: "Ship the change",
		}),
		typed("null budget clears it", {
			session_id: "s1",
			goal_id: "g1",
			revision: 2,
			token_budget: null,
		}),
		typed("numeric budget sets it", {
			session_id: "s1",
			goal_id: "g1",
			revision: 2,
			token_budget: 50000,
		}),
		invalid("fractional budget", { token_budget: 1.5 }),
	]),
	...group("ui_to_runtime_request", "run.steer", [
		typed("text steer", {
			run_id: "run-1",
			input: { type: "text", text: "focus on tests" },
		}),
		typed("parts steer with client id", {
			run_id: "run-1",
			input: {
				type: "parts",
				parts: [
					{ type: "text", text: "see image" },
					{
						type: "image_url",
						image_url: {
							url: "data:image/png;base64,AAAA",
							media_type: "image/png",
							detail: "high",
						},
					},
					{ type: "attachment_ref", attachment_id: "att_1" },
				],
			},
			client_steer_id: "local-1",
		}),
		invalid(
			"unknown input type",
			{ run_id: "run-1", input: { type: "audio", data: "" } },
			"unknown",
		),
		invalid("missing input", { run_id: "run-1" }),
	]),
	...group("runtime_to_ui_response", "initialize", [
		typed("full initialize result", {
			model_providers: ["openai", "anthropic"],
			protocol_version: "0",
			server: { name: "codelia-runtime", version: "0.1.86" },
			server_capabilities: {
				supports_run_steer: true,
				supports_goals: true,
				supports_theme_set: true,
				supported_task_kinds: ["shell", "subagent"],
				max_subagent_depth: 1,
				supports_attachment_upload: true,
				attachment_upload_limits: {
					max_file_bytes: 1048576,
					max_message_bytes: 4194304,
					max_attachments: 8,
					max_chunk_bytes: 65536,
					max_concurrent_uploads: 2,
				},
			},
			sandbox_mode: {
				value: "workspace-write",
				source: "default",
				legacy: "trusted",
			},
			tui: {
				theme: "ocean",
				auto_review: "unavailable",
				auto_review_issue: "unregistered_review_model",
				auto_review_confined_launch_enabled: false,
				auto_review_confined_launch_issue: "confined_launch_config_unavailable",
			},
		}),
		typed("minimal initialize result", {
			protocol_version: "0",
			server: { name: "runtime", version: "1" },
		}),
		{
			...typed("additive capability from a newer runtime", {
				protocol_version: "0",
				server: { name: "runtime", version: "1" },
				server_capabilities: { supports_future_feature: true },
			}),
			lossy: true,
		},
		invalid(
			"unknown auto review state",
			{
				protocol_version: "0",
				server: { name: "runtime", version: "1" },
				tui: { auto_review: "paused" },
			},
			"unknown",
		),
	]),
	...group("runtime_to_ui_response", "theme.set", [
		typed("theme saved", {
			name: "ocean",
			scope: "project",
			path: "/workspace/.codelia/config.json",
		}),
		typed("older runtime omits scope and path", { name: "ocean" }),
		invalid("unknown scope", { name: "ocean", scope: "workspace" }, "unknown"),
	]),
	...group("runtime_to_ui_response", "goal.set", [
		typed("goal snapshot without budget", {
			session_id: "s1",
			goal: {
				session_id: "s1",
				goal_id: "g1",
				revision: 3,
				objective: "Ship the change",
				status: "active",
				token_budget: null,
				tokens_used: 1200,
				usage_known: true,
				activation_id: "a1",
				automatic_runs: 0,
				created_at: "2026-11-22T00:00:00.000Z",
				updated_at: "2026-11-22T00:00:00.000Z",
			},
			can_continue: true,
		}),
		typed("empty snapshot", {
			session_id: null,
			goal: null,
			can_continue: false,
		}),
		invalid("snapshot without the required goal key", {
			session_id: null,
			can_continue: false,
		}),
	]),
	...group("runtime_to_ui_response", "run.steer", [
		typed("steer accepted", { ok: true, steer_id: "steer-1" }),
		invalid("steer result without id", { ok: true }),
		invalid("steer result that is not ok", { ok: false, steer_id: "steer-1" }),
	]),
	...group("runtime_to_ui_notification", "run.status", [
		typed("running", { run_id: "run-1", status: "running" }),
		typed("failed with error info", {
			run_id: "run-1",
			status: "error",
			message: "rate limited",
			error: {
				name: "ProviderError",
				message: "rate limited",
				provider: "openai",
				kind: "rate_limit",
				status: 429,
				attempts: 3,
				max_attempts: 3,
			},
		}),
		typed("cancelled with unconsumed steers", {
			run_id: "run-1",
			status: "cancelled",
			unconsumed_steer_ids: ["s2", "s3"],
		}),
		invalid(
			"unknown status",
			{ run_id: "run-1", status: "suspended" },
			"unknown",
		),
		invalid("missing run id", { status: "running" }),
	]),
	...group("runtime_to_ui_notification", "run.metrics", [
		typed("rate and timing", {
			run_id: "run-1",
			seq: 4,
			output_tokens_per_second: 88.5,
			timing: {
				time_to_first_token_ms: 420,
				generation_duration_ms: 1900,
				generation_start_ms: 300,
				generation_start_source: "reasoning_item",
			},
		}),
		typed("null rate clears the display", {
			run_id: "run-1",
			seq: 5,
			output_tokens_per_second: null,
		}),
		invalid("required nullable rate is missing", { run_id: "run-1", seq: 5 }),
	]),
	...group("runtime_to_ui_notification", "agent.event", [
		typed(
			"text",
			event({ type: "text", content: "Hello", timestamp: 1700000000000 }),
		),
		typed(
			"reasoning",
			event({ type: "reasoning", content: "Thinking", timestamp: 1 }),
		),
		typed(
			"text delta",
			event({ type: "text.delta", delta: "Hel", stream_id: "st-1", index: 0 }),
		),
		typed(
			"reasoning delta",
			event({
				type: "reasoning.delta",
				delta: "Th",
				stream_id: "st-1",
				index: 1,
			}),
		),
		typed(
			"llm retry",
			event({
				type: "llm.retry",
				provider: "openai",
				failure_kind: "rate_limit",
				next_attempt: 2,
				max_attempts: 5,
				delay_ms: 1500,
				delay_source: "retry-after",
				status: 429,
			}),
		),
		typed(
			"llm status verification",
			event({
				type: "llm.status",
				provider: "openai",
				kind: "verification",
				verification: "trusted_access_for_cyber",
			}),
		),
		typed(
			"llm status buffering",
			event({
				type: "llm.status",
				provider: "openai",
				kind: "buffering",
				active: true,
				faster_model: "gpt-6.1-terra",
			}),
		),
		typed(
			"step start",
			event({
				type: "step_start",
				step_id: "step-1",
				title: "Step 1",
				step_number: 1,
			}),
		),
		typed(
			"tool call",
			event({
				type: "tool_call",
				tool: "bash",
				args: { command: "ls", nested: { depth: [1, 2] } },
				raw_args: '{"command":"ls"}',
				tool_call_id: "call-1",
				display_name: "Shell",
			}),
		),
		typed(
			"tool result",
			event({
				type: "tool_result",
				tool: "bash",
				result: "ok",
				tool_call_id: "call-1",
				is_error: false,
				screenshot_base64: "AAAA",
			}),
		),
		{
			...typed(
				"tool result with null screenshot",
				event({
					type: "tool_result",
					tool: "bash",
					result: "ok",
					tool_call_id: "call-1",
					screenshot_base64: null,
				}),
			),
			lossy: true,
		},
		typed(
			"permission preview",
			event({
				type: "permission.preview",
				tool: "edit",
				tool_call_id: "call-2",
				file_path: "src/main.rs",
				language: "rust",
				diff: "@@ -1 +1 @@\n-a\n+b",
				summary: "1 line",
				truncated: false,
			}),
		),
		typed(
			"permission ready",
			event({ type: "permission.ready", tool: "edit", tool_call_id: "call-2" }),
		),
		typed(
			"step complete",
			event({
				type: "step_complete",
				step_id: "step-1",
				status: "completed",
				duration_ms: 12.5,
			}),
		),
		typed(
			"compaction start",
			event({ type: "compaction_start", timestamp: 1 }),
		),
		typed(
			"compaction complete",
			event({ type: "compaction_complete", timestamp: 2, compacted: true }),
		),
		typed(
			"hidden user message",
			event({ type: "hidden_user_message", content: "context" }),
		),
		typed(
			"steer applied with text",
			event({
				type: "steer_applied",
				steer_id: "s1",
				content: "focus on tests",
				timestamp: 1700000000000,
			}),
		),
		typed(
			"steer applied with parts",
			event({
				type: "steer_applied",
				steer_id: "s2",
				content: [
					{ type: "text", text: "look" },
					{
						type: "image_ref",
						image_ref: {
							artifact_id: "img-1",
							sha256: "0".repeat(64),
							media_type: "image/png",
							byte_size: 10,
							width: 2,
							height: 2,
						},
						detail: "auto",
					},
					{
						type: "attachment_ref",
						attachment_ref: {
							attachment_id: "att_1",
							sha256: "1".repeat(64),
							byte_size: 20,
							media_type: "text/plain",
							display_name: "notes.txt",
							origin: "file",
						},
					},
					{
						type: "other",
						provider: "openai",
						kind: "reasoning",
						payload: { id: "r1" },
					},
				],
				timestamp: 1700000000001,
			}),
		),
		typed(
			"final",
			event({
				type: "final",
				content: "Done",
				termination_reason: "normal",
			}),
		),
		typed(
			"replayed history event keeps open meta",
			event(
				{ type: "text", content: "old", timestamp: 1 },
				{ meta: { replayed: true, source: "history" } },
			),
		),
		invalid(
			"unknown event type",
			event({ type: "plan.update", steps: [] }),
			"unknown",
		),
		invalid(
			"unknown llm status kind",
			event({ type: "llm.status", provider: "openai", kind: "quota" }),
			"unknown",
		),
		invalid(
			"unknown retry failure kind",
			event({
				type: "llm.retry",
				provider: "openai",
				failure_kind: "quota",
				next_attempt: 2,
				max_attempts: 5,
				delay_ms: 10,
				delay_source: "backoff",
			}),
			"unknown",
		),
		invalid(
			"malformed known event",
			event({ type: "text", content: 5, timestamp: 1 }),
		),
		// Core normalizes unparsable or non-object arguments to { _raw }.
		invalid(
			"tool call args that are not an object",
			event({
				type: "tool_call",
				tool: "bash",
				args: null,
				raw_args: "null",
				tool_call_id: "call-1",
			}),
		),
		// Only an unknown string tag is forward-compatible; a missing or
		// mistyped tag is a contract violation.
		invalid("event type that is not a string", event({ type: 7 })),
		invalid(
			"llm status without kind",
			event({ type: "llm.status", provider: "openai" }),
		),
		invalid(
			"llm status with a non-string kind",
			event({ type: "llm.status", provider: "openai", kind: false }),
		),
		invalid("missing sequence number", {
			run_id: "run-1",
			event: { type: "text", content: "x", timestamp: 1 },
		}),
	]),
	...group("runtime_to_ui_notification", "client.tool.cancel", [
		typed("timeout", {
			request_id: "ui-3",
			run_id: "run-1",
			name: "tui_open_selector",
			reason: "timeout",
		}),
		invalid(
			"unknown reason",
			{ request_id: "ui-3", run_id: "run-1", name: "tool", reason: "user" },
			"unknown",
		),
	]),
	...group("runtime_to_ui_notification", "run.future", [
		{
			case: "method unknown to this client",
			value: { run_id: "run-1" },
			expect: "unknown",
			ts: "skip",
		},
	]),
	...group("runtime_to_ui_request", "client.tool.call", [
		typed("call with arguments", {
			run_id: "run-1",
			name: "tui_open_selector",
			arguments: { kind: "model" },
			raw_arguments: '{"kind":"model"}',
		}),
		typed("call without parsed arguments", {
			run_id: "run-1",
			name: "tui_show_progress",
			raw_arguments: "",
		}),
		invalid("missing raw arguments", { run_id: "run-1", name: "tool" }),
	]),
	...group("ui_to_runtime_response", "client.tool.call", [
		typed("text result", {
			ok: true,
			result: { type: "text", text: "selector opened" },
		}),
		typed("json result", {
			ok: true,
			result: { type: "json", value: { selected: ["a", 1, null] } },
		}),
		typed("success without result", { ok: true }),
		typed("success with a null result", { ok: true, result: null }),
		typed("failure", { ok: false, error: "unknown TUI client tool" }),
		invalid("missing ok tag", { result: "x" }),
		invalid("string ok tag", { ok: "true", result: "x" }),
	]),
];
