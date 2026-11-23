// Config, permissions, sandbox, Auto approve, models, images and credential
// storage (Phase 2).
import { group, invalid, type Sample, typed } from "./helpers";

const entry = {
	key: "search.mode",
	value: "auto",
	source: "global",
	global: "auto",
	type: "enum",
	enum: ["auto", "native", "local"],
	default_scope: "global",
	writable: true,
};
const sandbox = {
	effective: { value: "workspace-write", source: "default" },
	applied: { value: "workspace-write", target: "agent" },
	project: { writable: true },
	choices: [
		{ id: "readonly", label: "Read only", description: "No writes" },
		{
			id: "full-access",
			label: "Full access",
			description: "User account",
			unavailable_reason: "platform_unavailable",
		},
	],
};
const imageRef = {
	artifact_id: "codelia-image-00000000-0000-0000-0000-000000000000",
	sha256: "a".repeat(64),
	byte_size: 10,
	width: 1,
	height: 1,
	created_at: "2026-11-22T00:00:00.000Z",
};
const generated = {
	...imageRef,
	media_type: "image/png",
	provider: "openai",
	requested_model: "gpt-image-2",
	endpoint: "images",
	parent_artifact_ids: [],
};

export const settingsSamples: Sample[] = [
	...group("ui_to_runtime_request", "config.get", [
		typed("some keys", { keys: ["search.mode"] }),
		invalid("invalid keys", { keys: [42] }),
	]),
	...group("runtime_to_ui_response", "config.get", [
		typed("entries", {
			paths: { global: "/home/.codelia/config.json", project: null },
			entries: [
				entry,
				{
					...entry,
					key: "subagent.max_concurrent",
					value: 8,
					source: "default",
					type: "integer",
					min: 1,
					max: 16,
					enum: undefined,
					global: undefined,
				},
				{ ...entry, key: "x.flag", value: null, type: "boolean" },
			],
			errors: [{ scope: "project", message: "unreadable" }],
		}),
		invalid("missing project path", {
			paths: { global: "/g" },
			entries: [],
		}),
	]),
	...group("ui_to_runtime_request", "config.set", [
		typed("set a number", {
			scope: "project",
			key: "subagent.max_concurrent",
			value: 4,
		}),
		typed("unset", { scope: "global", key: "search.mode", unset: true }),
		invalid("object value", { scope: "global", key: "k", value: {} }),
	]),
	...group("runtime_to_ui_response", "config.set", [
		typed("saved", {
			key: "search.mode",
			scope: "global",
			path: "/g",
			entry,
			applies: "next_run",
		}),
		// `applies` is an open single-value enum: a new timing is kept as
		// unknown rather than rejected.
		invalid(
			"new applies value",
			{
				key: "search.mode",
				scope: "global",
				path: "/g",
				entry,
				applies: "now",
			},
			"typed",
		),
	]),
	...group("ui_to_runtime_request", "permissions.list", [
		typed("with system rules", { include_system: true }),
		invalid("invalid include system", { include_system: 1 }),
	]),
	...group("runtime_to_ui_response", "permissions.list", [
		typed("rules and launch rules", {
			remembered_tools: [{ tool: "search" }],
			project_allow_trust: {
				workspace: "/work",
				trusted: false,
				rules: [{ tool: "shell", command: "cargo test" }],
				revision: "r1",
			},
			sandbox_mode: { value: "workspace-write", source: "project" },
			approval_mode: null,
			paths: { global: "/g", project: "/work/.codelia/config.json" },
			rules: [
				{
					kind: "allow",
					scope: "system",
					rule: { tool: "read" },
					removable: false,
				},
			],
			launch_rules: [
				{
					id: "a".repeat(64),
					template: "exact-argv/v2",
					origin: "operator",
					executable: "/bin/example",
					profile: "development",
					cwd: "/work",
					args: ["x"],
					launchKind: "argv",
					argv0: "example",
					scope: "project",
				},
			],
			errors: [{ scope: "launch_rules", message: "busy" }],
		}),
		invalid("missing approval mode", {
			paths: { global: "/g", project: null },
			rules: [],
		}),
	]),
	...group("ui_to_runtime_request", "permissions.remove", [
		typed("remembered tool", { scope: "project", remembered_tool: "search" }),
		typed("workspace write grant", {
			resource: "workspace_write",
			scope: "session",
		}),
		typed("launch rule", { launch_rule_id: "a".repeat(64), scope: "session" }),
		typed("config rule", {
			scope: "project",
			kind: "deny",
			rule: { tool: "shell", command: "rm" },
		}),
		invalid("no identifying key", { scope: "project" }),
	]),
	...group("runtime_to_ui_response", "permissions.remove", [
		typed("remembered tool removed", {
			scope: "project",
			remembered_tool: "search",
			removed: 1,
		}),
		typed("rule removed", {
			scope: "global",
			kind: "allow",
			path: "/g",
			removed: 2,
		}),
		invalid("launch rule without count", {
			launch_rule_id: "a",
			scope: "session",
		}),
		invalid("no identifying key", { scope: "project", removed: 0 }),
	]),
	...group("ui_to_runtime_request", "permissions.projectTrust.set", [
		typed("trust", {
			workspace: "/work",
			trusted: true,
			expected_revision: "r1",
		}),
		invalid("missing trust choice", {}),
	]),
	...group("runtime_to_ui_response", "permissions.projectTrust.set", [
		typed("trusted", { workspace: "/work", trusted: true }),
		invalid("missing trust status", {}),
	]),
	...group("ui_to_runtime_request", "sandbox.get", [
		typed("no params", {}),
		{
			...invalid("unknown request key", { unexpected: true }, "typed"),
			lossy: true,
		},
	]),
	...group("runtime_to_ui_response", "sandbox.get", [
		typed("writable project", sandbox),
		typed("read-only project, nothing applied", {
			...sandbox,
			applied: null,
			project: { writable: false, reason: "cli_override" },
		}),
		invalid("read-only project without reason", {
			...sandbox,
			project: { writable: false },
		}),
	]),
	...group("ui_to_runtime_request", "sandbox.set", [
		typed("project mode", { scope: "project", mode: "readonly" }),
		invalid("other scope literal", { scope: "global", mode: "readonly" }),
	]),
	...group("runtime_to_ui_response", "sandbox.set", [
		typed("applied", sandbox),
		invalid("missing sandbox mode", {}),
	]),
	...group("ui_to_runtime_request", "auto_review.configure", [
		typed("status", { action: "status" }),
		typed("interactive setup", {}),
		{
			...invalid(
				"unknown request key",
				{ action: "status", unexpected: true },
				"typed",
			),
			lossy: true,
		},
	]),
	...group("runtime_to_ui_response", "auto_review.configure", [
		typed("active pinned reviewer", {
			mode: "pin",
			confined_launch_enabled: true,
			state: "active",
			provider: "openai",
			model: "gpt-6-luna",
			label: "OpenAI · gpt-6-luna",
			details: ["confined"],
		}),
		typed("unavailable", {
			state: "unavailable",
			confined_launch_enabled: false,
			issue: "review_config_unavailable",
		}),
		invalid("missing state", { mode: "follow" }),
	]),
	...group("ui_to_runtime_request", "model.list", [
		typed("with details", { provider: "openai", include_details: true }),
		invalid("invalid include details", { include_details: 1 }),
	]),
	...group("runtime_to_ui_response", "model.list", [
		typed("models with details", {
			providers: ["openai", "home"],
			reasoning_levels: { "gpt-6.1-sol": ["low", "max"], "text-only": [] },
			provider: "openai",
			models: ["gpt-6.1-sol"],
			current: "gpt-6.1-sol",
			source: "session",
			reasoning: "high",
			fast: "ultrafast",
			details: {
				"gpt-6.1-sol": {
					release_date: "2026-10-01",
					context_window: 1000000,
					cost_per_1m_input_tokens_usd: 1.25,
				},
			},
		}),
		typed("boolean fast mode", {
			provider: "openai",
			models: [],
			fast: false,
		}),
		invalid(
			"unknown speed tier",
			{ provider: "openai", models: [], fast: "hyperfast" },
			"unknown",
		),
		invalid("fractional context window", {
			provider: "openai",
			models: ["m"],
			details: { m: { context_window: 1.5 } },
		}),
	]),
	...group("ui_to_runtime_request", "model.set", [
		typed("session scope with fast", {
			name: "gpt-6.1-sol",
			provider: "openai",
			reasoning: "xhigh",
			fast: true,
			scope: "session",
		}),
		typed("reset session override", { scope: "session", reset: true }),
		invalid("invalid model scope", { scope: 1 }),
	]),
	...group("runtime_to_ui_response", "model.set", [
		typed("saved", {
			provider: "openai",
			name: "gpt-6.1-sol",
			source: "config",
			fast: "ultrafast",
		}),
		invalid("missing source", { provider: "openai", name: "m" }),
	]),
	...group("ui_to_runtime_request", "image.model.get", [
		typed("get", {}),
		invalid("not an object", []),
	]),
	...group("runtime_to_ui_response", "image.model.get", [
		typed("available", {
			auth_mode: "codex_oauth",
			requested_mode: "builtin",
			state: "available",
			message: "Image generation: builtin",
			provider: "openai",
			requested_model: "gpt-image-2",
		}),
		invalid("configure-shaped result", {
			message: "Image settings unchanged.",
		}),
	]),
	...group("ui_to_runtime_request", "image.model.configure", [
		typed("google custom", {
			mode: "custom",
			provider: "google",
			model: "gemini-nano-banana-2.1",
			image_size: "4K",
			aspect_ratio: "1:1",
			output_format: "jpeg",
		}),
		typed("picker", {}),
		{
			...invalid(
				"unknown request key",
				{ mode: "off", unexpected: true },
				"typed",
			),
			lossy: true,
		},
	]),
	...group("runtime_to_ui_response", "image.model.configure", [
		typed("unchanged", { message: "Image settings unchanged." }),
		typed("saved", {
			requested_mode: "off",
			state: "disabled",
			message: "Image generation is off.",
		}),
		invalid("missing message", { state: "disabled" }),
	]),
	...group("ui_to_runtime_request", "image.artifact.get", [
		typed("by id", { artifact_id: imageRef.artifact_id }),
		{
			...invalid(
				"unknown request key",
				{
					artifact_id: "codelia-image-01234567-89ab-cdef-0123-456789abcdef",
					unexpected: true,
				},
				"typed",
			),
			lossy: true,
		},
	]),
	...group("runtime_to_ui_response", "image.artifact.get", [
		typed("attachment", {
			metadata: { ...imageRef, media_type: "image/webp", kind: "attachment" },
			data_url: "data:image/webp;base64,AAAA",
		}),
		typed("generated", {
			metadata: { ...generated, kind: "generated", usage: { cost_usd: 0.04 } },
			data_url: "data:image/png;base64,AAAA",
		}),
		{
			// Written before `kind` existed; Rust re-serializes it with the tag.
			case: "generated metadata without kind",
			value: { metadata: generated, data_url: "data:image/png;base64,AAAA" },
			expect: "typed",
			ts: "valid",
			lossy: true,
		},
		invalid("generated metadata with a non-string kind", {
			metadata: { ...generated, kind: 1 },
			data_url: "data:image/png;base64,AAAA",
		}),
	]),
	...group("ui_to_runtime_request", "auth.storage.resolve_conflict", [
		typed("keep keychain for one store", {
			strategy: "keep_keyring",
			stores: ["auth"],
			confirmed: true,
		}),
		invalid("missing strategy", { stores: ["auth"] }),
	]),
	...group("runtime_to_ui_response", "auth.storage.resolve_conflict", [
		typed("resolved", {
			ok: true,
			active: "keyring",
			resolved_stores: ["auth", "mcp_auth"],
		}),
		invalid("missing completion status", {}),
	]),
	...group("runtime_to_ui_response", "auth.status", [
		typed("storage summary and warnings", {
			providers: [],
			storage: {
				configured: "auto",
				active: "file",
				state: "conflict",
				fallback_reason: "keychain_locked",
			},
			warnings: [
				{
					code: "storage_conflict",
					message: "Resolve the conflict.",
					targets: ["auth"],
				},
			],
		}),
	]),
];
