// Shell, tasks, tool.call, MCP, skills, context and ui.context.update
// (Phase 2).
import { group, invalid, type Sample, typed } from "./helpers";

const truncated = { stdout: false, stderr: false, combined: false };
const shellTask = {
	task_id: "task-1",
	state: "completed",
	command_preview: "echo hi",
	created_at: "2026-11-22T00:00:00.000Z",
	updated_at: "2026-11-22T00:00:01.000Z",
	exit_code: 0,
	stdout: "hi\n",
	stderr: "",
	truncated,
	duration_ms: 12.5,
};
const task = {
	task_id: "task-2",
	key: "build-1234abcd",
	kind: "subagent",
	workspace_mode: "live_workspace",
	state: "running",
	name: "Mika",
	created_at: "2026-11-22T00:00:00.000Z",
	updated_at: "2026-11-22T00:00:01.000Z",
	exit_code: null,
	duration_ms: null,
	usage: { total_tokens: 1200, total_cost_usd: 0.02 },
	progress: {
		step: 2,
		phase: "tool",
		current_tool: {
			name: "read",
			tool_call_id: "call-1",
			started_at: "2026-11-22T00:00:01.000Z",
		},
		tool_calls: 3,
		updated_at: "2026-11-22T00:00:01.000Z",
	},
	subagent: {
		tree_id: "tree-1",
		node_id: "node-1",
		parent_node_id: "root",
		owner_session_id: "session-1",
		depth: 1,
		spawn_index: 0,
		context_mode: "fresh",
		effective_policy_id: "policy-1",
		workspace_lease_id: "lease-1",
	},
};
const usage = {
	provider: "openai",
	model: "gpt-6.1-sol",
	limit_tokens: 270000,
	used_tokens: 12000,
	input_tokens: 11000,
	left_percent: 95.5,
	basis: "provider",
	breakdown: [
		{ category: "messages", tokens: 9000 },
		{ category: "images", tokens: 500, count: 1 },
	],
};

export const taskSamples: Sample[] = [
	...group("ui_to_runtime_request", "shell.exec", [
		typed("with timeout", { command: "ls", timeout_seconds: 30 }),
		invalid("missing command", { timeout_seconds: 30 }),
	]),
	...group("runtime_to_ui_response", "shell.exec", [
		{
			// `signal: null` collapses to absent in Rust.
			case: "finished",
			value: {
				command_preview: "ls",
				exit_code: 0,
				signal: null,
				stdout: "a\n",
				stderr: "",
				truncated: { ...truncated, stdout: true },
				duration_ms: 4,
				stdout_cache_id: "cache-1",
			},
			expect: "typed",
			ts: "valid",
			lossy: true,
		},
		invalid("missing exit code key", {
			command_preview: "ls",
			stdout: "",
			stderr: "",
			truncated,
			duration_ms: 1,
		}),
	]),
	...group("ui_to_runtime_request", "shell.start", [
		typed("start", { command: "bun run build" }),
	]),
	...group("runtime_to_ui_response", "shell.start", [
		typed("queued", {
			...shellTask,
			state: "queued",
			exit_code: null,
			duration_ms: null,
		}),
	]),
	...group("ui_to_runtime_request", "shell.wait", [
		typed("bounded wait", { task_id: "task-1", wait_timeout_seconds: 120 }),
	]),
	...group("runtime_to_ui_response", "shell.wait", [
		typed("finished task", shellTask),
		typed("still running", {
			...shellTask,
			state: "running",
			still_running: true,
		}),
		typed("detached", { task_id: "task-1", detached: true, state: "running" }),
		invalid("neither task nor detach", { task_id: "task-1", state: "running" }),
	]),
	...group("ui_to_runtime_request", "shell.detach", [
		typed("detach", { task_id: "task-1" }),
	]),
	...group("runtime_to_ui_response", "shell.detach", [
		typed("detached", { task_id: "task-1", detached: true, state: "running" }),
		invalid("not detached", {
			task_id: "task-1",
			detached: false,
			state: "running",
		}),
	]),
	...group("ui_to_runtime_request", "shell.output", [
		typed("one line", {
			task_id: "task-1",
			stream: "stdout",
			line_number: 3,
			char_limit: 200,
		}),
	]),
	...group("runtime_to_ui_response", "shell.output", [
		typed("cached output", {
			task_id: "task-1",
			stream: "stderr",
			cached: true,
			ref_id: "cache-2",
			content: "warning",
		}),
	]),
	...group("runtime_to_ui_response", "shell.list", [
		typed("tasks", { tasks: [shellTask] }),
	]),
	...group("ui_to_runtime_request", "task.spawn", [
		typed("subagent with model", {
			kind: "subagent",
			name: "Mika",
			prompt: "Review the parser",
			model: { provider: "openai", name: "gpt-6.1-sol", fast: true },
			workspace_access: "read-only",
			max_steps: 40,
		}),
		invalid("missing kind", { prompt: "x" }),
	]),
	...group("runtime_to_ui_response", "task.spawn", [
		typed("summary", task),
		typed("finished shell task", {
			...task,
			kind: "shell",
			state: "completed",
			exit_code: 0,
			duration_ms: 30,
			stdout: "ok",
			truncated,
			artifacts: [{ type: "patch", ref: "patch-1" }],
			subagent: undefined,
			progress: undefined,
		}),
	]),
	...group("ui_to_runtime_request", "task.list", [
		typed("running subagents", { kind: "subagent", state: "running" }),
		typed("defaults", {}),
	]),
	...group("runtime_to_ui_response", "task.list", [
		typed("tasks", { tasks: [task] }),
		invalid("task without workspace mode", {
			tasks: [{ ...task, workspace_mode: undefined }],
		}),
	]),
	...group("ui_to_runtime_request", "task.status", [
		typed("by id", { task_id: "task-2" }),
	]),
	...group("runtime_to_ui_response", "task.status", [
		typed("task", task),
		{
			// An unknown cost may be sent as `null`, which collapses in Rust.
			case: "unknown cost",
			value: { ...task, usage: { total_tokens: 5, total_cost_usd: null } },
			expect: "typed",
			ts: "valid",
			lossy: true,
		},
	]),
	...group("runtime_to_ui_response", "task.result", [
		typed("not finished", null),
		typed("finished", { ...task, state: "completed", summary: "Done" }),
	]),
	...group("ui_to_runtime_request", "tool.call", [
		typed("with arguments", { name: "lane_list", arguments: {} }),
		invalid("array arguments", { name: "lane_list", arguments: [] }),
	]),
	...group("runtime_to_ui_response", "tool.call", [
		typed("tool output", { ok: true, result: { lanes: [] } }),
		typed("failed with null output", { ok: false, result: null }),
	]),
	...group("ui_to_runtime_request", "mcp.list", [
		typed("configured", { scope: "configured" }),
	]),
	...group("runtime_to_ui_response", "mcp.list", [
		typed("servers", {
			servers: [
				{
					id: "docs",
					transport: "http",
					source: "project",
					enabled: true,
					state: "auth_required",
					tools: 0,
					last_error: "401",
				},
			],
		}),
	]),
	...group("ui_to_runtime_request", "skills.list", [
		typed("reload", { force_reload: true }),
	]),
	...group("runtime_to_ui_response", "skills.list", [
		typed("catalog", {
			skills: [
				{
					id: "s1",
					name: "review",
					description: "Review code",
					path: "/skills/review/SKILL.md",
					dir: "/skills/review",
					scope: "repo",
					mtime_ms: 1767225600000,
				},
			],
			errors: [{ path: "/skills/bad/SKILL.md", message: "missing name" }],
			truncated: false,
		}),
	]),
	...group("ui_to_runtime_request", "context.inspect", [
		typed("everything", { include_agents: true, include_skills: true }),
	]),
	...group("runtime_to_ui_response", "context.inspect", [
		typed("snapshot", {
			runtime_working_dir: "/work",
			ui_context: { cwd: "/work", active_file_path: "src/main.rs" },
			runtime_environment: { preset: "tui-local" },
			agents: {
				enabled: true,
				root_dir: "/work",
				working_dir: "/work",
				covered_dirs: ["/work"],
				initial_files: [
					{ path: "/work/AGENTS.md", mtime_ms: 1, size_bytes: 100 },
				],
				loaded_files: [],
			},
			skills: {
				root_dir: "/work",
				working_dir: "/work",
				catalog: { skills: [], errors: [], truncated: false },
				loaded_versions: [{ path: "/skills/review/SKILL.md", mtime_ms: 2 }],
			},
		}),
	]),
	...group("ui_to_runtime_request", "context.usage", [typed("no params", {})]),
	...group("runtime_to_ui_response", "context.usage", [
		typed("provider usage", { ...usage, session_id: "session-1" }),
		typed("no agent yet", {
			provider: null,
			model: null,
			limit_tokens: null,
			used_tokens: null,
			input_tokens: null,
			left_percent: null,
			basis: "none",
			breakdown: [],
		}),
		invalid("missing used tokens key", { ...usage, used_tokens: undefined }),
	]),
	...group("ui_to_runtime_notification", "ui.context.update", [
		typed("selection", {
			cwd: "/work",
			workspace_root: "/work",
			active_file: { path: "src/main.rs", language_id: "rust" },
			selection: {
				path: "src/main.rs",
				range: {
					start: { line: 1, column: 0 },
					end: { line: 1, column: 10 },
				},
				selected_text: "fn main()",
			},
		}),
		invalid("fractional line", {
			selection: {
				path: "a",
				range: {
					start: { line: 0.5, column: 0 },
					end: { line: 1, column: 0 },
				},
			},
		}),
	]),
];
