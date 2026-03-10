# @codelia/runtime

runtime (JSON-RPC stdio server) that connects Core and UI.
Responsible for receiving UI protocols, executing agents, and implementing tools.
Built-in basic tools (bash/shell/shell_list/shell_status/shell_logs/shell_wait/shell_result/shell_cancel/read/write/edit/agents_resolve/grep/glob/todo_read/todo_new/todo_append/todo_patch/todo_clear/done + lane_create/lane_list/lane_status/lane_close/lane_gc) and sandbox. The default root of the sandbox is the current directory at startup, which can be overwritten with `CODELIA_SANDBOX_ROOT`.
Runtime todo writes are split across `todo_new`, `todo_append`, `todo_patch`, and `todo_clear`; todo items include stable `id` and `priority`, and runtime rejects states with more than one `in_progress` item.
`todo_read` returns the full plan/task rows, while `todo_new` / `todo_append` / `todo_patch` return delta-oriented summaries (changed ids + compact counts/next hint) instead of echoing the whole plan. Stored `notes` are not rendered, and `Next` hints expose task id only (`Next: [id]`) using the same displayed task order.
Todo state is scoped by runtime `session_id` (not sandbox UUID) and persisted in `SessionState.meta.codelia_todos`, so `run.start.session_id` resume restores the plan after runtime restart.
Sandbox file/path tools stay bounded by `CODELIA_SANDBOX_ROOT` in `minimal`/`trusted`, but `full-access` resolves file/path arguments with normal user-level path semantics (no logical sandbox path guard).
Sandbox path violations from runtime file/path tools are thrown as hard tool errors (`is_error=true`), not returned as normal text results.

tool definition guide (description/field describe):
- Write `defineTool.description` concisely in one sentence (approximately 120 characters or less).
- Give top priority to what the tool does, and avoid implementation details and duplicate explanations.
- For the numeric parameter `describe`, specify `unit / default / max` briefly only when necessary.
- Keep the text of `describe` short and consistent, and use the same vocabulary to describe items with the same meaning (e.g. `0-based`, `Default`, `Max`).
- Put long notes on the AGENTS.md / spec side, and leave only the minimum on the tool schema side.
- Keep the shared system prompt focused on when/how to reach for a tool; put exact behavior, defaults, limits, and parameter semantics in the tool description/schema so the tool definition remains the source of truth.

Get model metadata at startup, and if the selected model is not found, force refresh `models.dev` and recheck. If metadata is still missing but the model exists in `DEFAULT_MODEL_REGISTRY`, strict startup continues using default registry spec (strict error remains only for unknown models in both metadata and default registry).
The system prompt reads `packages/core/prompts/system.md` (can be overwritten with `CODELIA_SYSTEM_PROMPT_PATH`).
For model settings, read `model.*` of `config.json` and select openai/anthropic/openrouter.
When a static registry entry uses `providerModelId` (for example a capped/full-context split of one provider model), runtime preserves the configured model id for context budgeting and UI, but resolves the provider model id for OpenAI request/metadata/reasoning handling.
For Anthropic, runtime resolves `max_tokens` from model metadata limits (`max_output_tokens` -> `max_input_tokens` -> `context_window`) and guarantees it stays above `thinking.budget_tokens`.
`model.provider=openrouter` composes core `ChatOpenRouter` (dedicated connector) instead of reusing `ChatOpenAI`.
When building runtime `modelRegistry` for OpenRouter, resolve the configured model id case-insensitively and register it dynamically with context/input/output limits from metadata so context-left/compaction can resolve dynamic OpenRouter models.
OpenAI can override `text.verbosity` in `Responses API` with `model.verbosity` (low/medium/high).
When OpenAI `experimental.openai.websocket_mode=auto` falls back from websocket to HTTP, runtime emits a visible warning once per run while continuing over HTTP.
Search behavior is configured by `search.*` in config (`mode=auto|native|local`).
In `mode=auto`, runtime prefers provider-native search for supported providers and otherwise exposes local `search` tool.
Local `search` tool supports `ddg`/`brave` backends; `brave` reads API key from `search.local.brave_api_key_env` (default `BRAVE_SEARCH_API_KEY`).
`search` is not in system allowlist by default (permission confirm required unless explicitly allowed).
The defaults are registered in `configRegistry` on the core side, and the runtime uses only the synthesized settings.
The project settings (`.codelia/config.json`) are read by runtime and synthesized with the global config (CLI is not supported).
You can override the global config location with `CODELIA_CONFIG_PATH`.
Get the model list and update the config using RPC `model.list` / `model.set` (model.set recreates the Agent).
`model.list` returns the context window / input/output limit in `include_details=true` (omitted if it cannot be obtained). For static providers, displayed limits follow the merged runtime registry (same precedence as execution), not raw metadata rows.
`model.list` sorts by `release_date` (newest first when available) and can include normalized cost fields (`cost_per_1m_*_usd`) in details.
If provider of `model.list` is not specified, the provider of config is given priority and a list is returned.
On startup after `initialize`, if no stored/env auth exists, runtime starts first-run onboarding via UI pick/prompt (provider -> auth -> model) before the first run.
`initialize` response includes resolved `tui.theme` (merged global/project config) so UI can apply the saved theme immediately at startup.
Return skills catalog (name/description/path/scope + errors) with RPC `skills.list`.
Return a snapshot of runtime/UI/AGENTS resolver (including loaded AGENTS.md path) with RPC `context.inspect`.
`context.inspect` can return skills catalog/loaded_versions with `include_skills=true`.
Load `mcp.servers` (global/project merge) and start MCP server connection when runtime starts.
The MCP adapter tool is generated at runtime, and `@codelia/core` does not have MCP transport/lifecycle.
Provide RPC `mcp.list` and return server state/tool number for `/mcp`.
MCP HTTP assigns a token of `mcp-auth.json` with Bearer and tries to reacquire it with refresh token when 401 occurs.
MCP server that requires OAuth authenticates with Authorization Code + PKCE (localhost callback) and saves the obtained token in `mcp-auth.json`.
OpenAI auth offers device-code login for SSH/headless environments via `https://auth.openai.com/api/accounts/deviceauth/*` and exchanges the returned authorization code at `https://auth.openai.com/deviceauth/callback`.
OAuth browser launch defaults to `manual` when `SSH_CONNECTION` / `SSH_CLIENT` / `SSH_TTY` is present; override with `CODELIA_OAUTH_BROWSER=auto|manual`.
Manual SSH OAuth can complete by pasting the redirected callback URL (or `code=...&state=...`) into the TUI.
OAuth metadata is automatically detected from `/.well-known/oauth-protected-resource` and authorization-server metadata, and can be overwritten with `mcp.servers.<id>.oauth.*` of `config.json`.
If 401 is returned by an HTTP server that can resolve OAuth metadata, the state will be treated as `auth_required` and will transition to waiting for authentication instead of `connect failed`.
Session store writes to `sessions/YYYY/MM/DD/<run_id>.jsonl` and runtime
Record `run.start` / `run.status` / `run.end` / `agent.event` / `run.context`.
If `CODELIA_DIAGNOSTICS=1`, runtime emits `run.diagnostics` notifications (`llm_call`/`run_summary`) derived in-memory from `llm.request`/`llm.response`; diagnostics are not persisted as session records.
`run.start` accepts `input.type="text"` and `input.type="parts"` (text/image_url), validates multimodal parts, and forwards them to Agent as `string | ContentPart[]`.
LLM calls and tool output are logged from the core's session hook.
Save session resume state via `@codelia/storage` (`sessions/state.db` index +
`sessions/messages/<session_id>.jsonl` payload), expose via `session.list`, and
restore with `run.start.session_id` (history is snapshot at the end of run).
`session.history` resends `agent.event` of the past run, and TUI redraws the history.
`session.history.max_events` is applied as a tail limit after collecting events from the selected runs, so truncated restores keep the most recent events rather than the oldest replayed prefix.
Before running the tool, determine permission and obtain approval using UI confirm (allowlist/denylist is `permissions` in config).
`trusted` extends system allowlist with workspace write tools (`write`/`edit`) and trusted shell commands (`sed`/`awk`).
System tool allowlist (`minimal`/`trusted`) includes `read_line` and `tool_output_cache_line` so fail-fast read fallbacks can continue without extra confirms.
Approval mode is resolved in runtime with precedence `--approval-mode` flag > `CODELIA_APPROVAL_MODE` > global `projects.json` project entry > global `projects.json` default > startup selection (UI pick, unresolved only) > fallback `minimal`.
Invalid approval-mode values from CLI/env are surfaced as explicit errors (not silently ignored).
`projects.json` is loaded from storage config dir (`~/.codelia/projects.json` or XDG config equivalent) and keyed by normalized sandbox root/project path.
If `projects.json` is malformed/invalid, runtime surfaces an explicit load error (no silent fallback).
When logging permission preflight context, flush those `agent.event` messages before sending `ui.confirm.request` so UI history is rendered before the modal confirm appears (legacy raw-args JSON text is not emitted; use structured `permission.preview`/`permission.ready` events).
Runtime emits structured permission preflight events (`permission.preview` / `permission.ready`) before `ui.confirm.request` and does not emit the legacy text preflight format.
`permission.preview` can include `language` (preferred) and `file_path` so UI can infer syntax even when diff headers are missing/truncated.
`permission.preview` / `permission.ready` include `tool_call_id` so UI can correlate preflight previews with `tool_result` and suppress duplicate diff rendering.
shell permission evaluation splits the command into segments and automatically allows it only if all segments are allowed.
The agent-facing `shell` tool is task-backed internally: attached runs wait for completion, and `background=true` detaches the wait while the runtime continues to own the child process.
Agent-facing `shell` start accepts an optional short `label` distinct from the generated command preview/title; runtime converts that display label into a stable unique public `key` (for example `shell-xxxxxxxx` or `build-xxxxxxxx`) that is persisted with the task.
Agent-facing follow-up tools `shell_list` / `shell_status` / `shell_logs` / `shell_wait` / `shell_result` / `shell_cancel` operate on retained shell tasks; follow-up tools accept the returned `key`, `label` is display-only, and `shell_list` defaults to compact active-task summaries (`key` / optional `label` / `command` / `state` plus terminal reason fields such as `failure_message` or `cancellation_reason`).
`shell_wait` uses a bounded attached-wait window (default 120s, max 300s) and returns `still_running: true` with current task info instead of hanging indefinitely when the task has not finished yet.
Live agent-facing `shell_logs` reads are bounded to a recent tail window; `tail_lines` can request the last N lines for live or retained output, and the response surfaces truncation metadata instead of returning the full active in-memory buffer.
For the agent-facing `shell` tool, foreground runs use `timeout` default 120 seconds and cap it at 300 seconds; `background=true` accepts larger timeout values up to the Node timer limit (`2147483s`), and omitting `timeout` means the managed child job runs until completion, cancellation, or runtime shutdown/exit.
Persistent services are outside the managed shell-task lifecycle: agents must use explicit shell-native out-of-process techniques (`nohup`, `setsid`, daemon CLIs, `docker compose up -d`, etc.) when they need work to survive runtime exit, and must verify readiness/liveness separately.
Tool output cache total-budget trim is disabled by default in runtime to preserve prompt prefix stability; set `CODELIA_TOOL_OUTPUT_TOTAL_TRIM=1` to re-enable total-budget replacement trim.
When using `rg` via shell, make the search path explicit like `rg <pattern> .` (to avoid hangs due to non-interactive stdin reads).
If you select "Don't ask again" in confirm, an allow rule will be added to the project config.
Shell remember splits a command and saves each segment as `command` (basically 1/2 words, 3 words for launchers such as `npx`/`bunx`/`npm exec`/`pnpm dlx`/`pnpm exec`/`yarn dlx`).
`skill_load` evaluates allow/deny for each skill name using `permissions.*.skill_name` and also saves remember using `{ tool: "skill_load", skill_name }`.
`cd` is not an allowlist, but only automatically allows paths inside the sandbox, and outside the sandbox is set to confirm (does not save as remember).
If you select `Deny` for permission confirm, the turn will stop if no reason is entered, and if the reason is entered, the turn will continue with the tool deny result in the context.
Lane tools are worktree-first orchestration helpers for autonomous runs (`lane_*`).
In MVP, `tmux` backend is implemented; selecting `zellij` currently returns an unsupported error.
`lane_create.seed_context` is passed as TUI startup option (`--initial-message`) so the lane can auto-start the first run when the UI becomes send-ready.
Lane tool responses include operator hints such as `attach_command`, `enter_worktree_command`, and follow-up tool args (`lane_status`/`lane_close`).
`lane_create` default worktree root is home-side `~/.codelia/worktrees` (repo-local path is no longer the default); `worktree_path` is optional override.

Reference specifications:
- dev-docs/specs/ui-protocol.md

Launch for development:
- OpenAI: `OPENAI_API_KEY=... bun packages/runtime/src/index.ts`
- Anthropic: `ANTHROPIC_API_KEY=... bun packages/runtime/src/index.ts`
- OpenRouter: `OPENROUTER_API_KEY=... bun packages/runtime/src/index.ts`
- If you want to log OpenAI OAuth HTTP 4xx/5xx: `CODELIA_DEBUG=1`
- OpenRouter app headers (optional): `OPENROUTER_HTTP_REFERER` / `OPENROUTER_X_TITLE`
- If you want to check the history snapshot after compaction in runtime log: `CODELIA_DEBUG=1` (output `compaction context snapshot ...`)
- If you want to track run lifecycle / tool event / transport backpressure in detail: `CODELIA_DEBUG=1`
- In `CODELIA_DEBUG=1`, run failure path logs `stream.error` with name/message/stack/cause/extras before emitting `run.status=error`.
- If you want to inspect provider request payload stability, set `CODELIA_PROVIDER_LOG=1` (stderr: bytes/hash/shared-prefix ratio). Request/response JSON dumps are written to project `./tmp` by default; set `CODELIA_PROVIDER_LOG_DIR` to override.
- OpenAI OAuth client options include `defaultHeaders.ChatGPT-Account-ID` (when available) so websocket handshake can reuse account routing headers in addition to HTTP fetch middleware.

Integration test:
- Execute only if `INTEGRATION=1` and API key exists.
- OpenAI: `OPENAI_API_KEY` + `CODELIA_TEST_OPENAI_MODEL`
- Anthropic: `ANTHROPIC_API_KEY` + `CODELIA_TEST_ANTHROPIC_MODEL`
- Tests point XDG environment variables to temporary directories to isolate storage space.

Implementation notes:
- Runtime entries have been delegated to `src/index.ts` → `src/runtime.ts` and divided into `src/rpc`, `src/tools`, `src/sandbox`, `src/utils`.
- RPC handler is divided into `src/rpc/handlers.ts` (wiring) and `src/rpc/run.ts` / `src/rpc/history.ts` / `src/rpc/model.ts` (responsible implementation).
- Execution state is encapsulated in `src/runtime-state.ts`.
- `createAgentFactory` is singleflight, and the Agent is constructed only once even if there are simultaneous initialization requests.
- `agent.event` sends `AgentEvent` of `@codelia/shared-types` to the protocol notification as is.
- If you terminate the stream midway with run.cancel, normalize the inconsistent history of tool call / tool output with `src/rpc/run.ts` so that it will not be broken in the next run.
- Even when `run.cancel` arrives during terminal/finally session-save timing, `src/rpc/run.ts` re-normalizes runtime in-memory history before run teardown to avoid carrying dangling tool-call pairs into the next run.
- `src/rpc/run.ts` also normalizes the existing in-memory agent history at the start of every `run.start`, so a previously interrupted turn cannot poison the next turn with `No tool output found for function call ...`.
- Session-state save/restore in `src/rpc/run.ts` also normalizes dangling tool_call/tool output pairs to avoid persisting an OpenAI-incompatible history snapshot during in-flight saves.
- When `run.start` receives `force_compaction=true`, it can force compaction without using normal input.
- Create run event storage via `RunEventStoreFactory` and hide storage implementation details from `run.ts`.
- `session.history` reads one header line at the beginning of the run log as a stream (fixed-length buffers are not used because they will be cut off by a huge header).
- AGENTS hierarchy resolver is located in `src/agents/`, embeds `AGENTS.md` of `root -> cwd` in the initial system prompt, and performs differential resolution explicitly using the `agents_resolve` tool.
- Skills resolver is located in `src/skills/`, and only catalog is injected as `skills_catalog` to the initial system prompt (the main text is only when `skill_load` is executed).
- Tools for Skills are `skill_search` / `skill_load`. `skill_load` suppresses `path + mtime` reloading within session.
- The read tool receives `offset`/`limit` and always returns a bounded truncated preview by default. Long lines are clipped and oversized reads are truncated with continuation hints; use `read_line` when exact long-line content matters. Default caps are `CODELIA_READ_MAX_BYTES=65536` and `CODELIA_READ_MAX_LINE_LENGTH=1000` (both env-overridable).
- `read_line` is the long-line fallback tool: reads one physical line by `line_number` (1-based) with `char_offset`/`char_limit` paging.
- Provide tool_output_cache / tool_output_cache_grep as standard tools.
- `tool_output_cache` returns a bounded truncated preview by default: long lines are clipped and oversized reads are truncated with continuation hints. Use `tool_output_cache_line` when exact long-line cache content matters. Cache caps are env-overridable via `CODELIA_TOOL_OUTPUT_CACHE_MAX_READ_BYTES`, `CODELIA_TOOL_OUTPUT_CACHE_MAX_GREP_BYTES`, and `CODELIA_TOOL_OUTPUT_CACHE_MAX_LINE_LENGTH` (default line cap 1000).
- `tool_output_cache_line` is the cache long-line fallback tool: reads one cached physical line by `line_number` (1-based) with `char_offset`/`char_limit` paging.
- The grep tool accepts `path` for both file/dir, and searches only a single file when file is specified.
- The edit tool returns `old_string === new_string` (and non-empty) as a no-op success instead of an error.
- The MCP implementation has been separated into `src/mcp/tooling.ts` (tool adapter/list acquisition) and `src/mcp/oauth-helpers.ts` (metadata/token helper), centered on `src/mcp/manager.ts`.
- MCP transport has been separated into `src/mcp/client.ts` (contract) + `src/mcp/stdio-client.ts` / `src/mcp/http-client.ts` + `src/mcp/jsonrpc.ts` / `src/mcp/sse.ts`.
- `src/mcp/stdio-client.ts` also cancels the abort listener at request timeout and prevents listeners from accumulating in the same `AbortSignal`.
- MCP HTTP client interprets the `text/event-stream` response of Streamable HTTP, extracts and processes the `event: message` JSON-RPC payload (ignores control events such as `event: endpoint`).
- SSE parsing of `src/mcp/sse.ts` uses `eventsource-parser` (handwritten block parser is obsolete).
- MCP auth storage uses `McpAuthStore` of `@codelia/storage` (`src/mcp/auth-store.ts` is re-export).
- MCP OAuth callback wait timeout is 180 seconds by default and can be overwritten with `CODELIA_MCP_OAUTH_TIMEOUT_MS`.
- Use the `oauth4webapi` utility to generate PKCE/state for MCP OAuth.
- Common implementation of OAuth callback server / PKCE / state is consolidated into `src/auth/oauth-utils.ts` and shared by OpenAI/MCP OAuth.
- `src/auth/oauth-utils.ts` also resolves shared OAuth browser mode and callback parsing helpers.
- The callback server of `src/auth/oauth-utils.ts` is implemented in `node:http` and operates without dependence on `Bun` in Node runtime.
- OpenAI OAuth browser launch on Windows uses `rundll32 url.dll,FileProtocolHandler <url>` (avoid `cmd start` query-splitting on `&`).
- Content debug string conversion of `src/rpc/run.ts` uses `stringifyContent(..., { mode: "log" })` of `@codelia/core`.
- RPC `shell.exec` is available for UI-origin bang commands (`origin=ui_bang`), bypasses confirm, enforces sandbox-bounded cwd, and can return excerpt + `stdout_cache_id`/`stderr_cache_id` for large output.
- `shell.exec` is now task-backed internally (`TaskManager.spawn + wait`) while preserving the existing RPC response shape.
- Runtime also exposes shell-task compatibility RPCs (`shell.start/list/status/output/wait/detach/cancel`) with `supports_shell_tasks` / `supports_shell_detach`, all reusing the same `TaskManager` + shell executor path as `shell.exec`.
- Runtime now also exposes generic public task RPCs (`task.spawn/list/status/wait/cancel/result`) with `supports_tasks`; today `task.spawn` is shell-backed only and rejects unsupported kinds (for example `subagent`) or `workspace_mode=worktree` explicitly.
- Generic `task.*` RPC summaries now include a shell task's public `key` when available (or a deterministic `shell-xxxxxxxx` fallback for direct shell-backed task records) so UIs can surface the human-usable identifier without exposing raw UUID-only task references.
- `task.spawn` honors `background=false`: the RPC waits for shell completion and returns terminal task info/output; the default/background path still returns the immediate task summary.
- `shell_logs.tail_lines` trims the synthetic trailing empty line created by newline-terminated output before counting tail lines, so `tail_lines: 1` returns the actual last printed line for normal CLI output.
- `shell.output` resolves shell `stdout`/`stderr` by task id; for terminal large output it delegates to `ToolOutputCacheStoreImpl.read/readLine`, and while the task is still running it reads the active in-memory executor buffer through `TaskManager.readOutput(...)`.
- `shell.wait` now supports in-flight detach via `shell.detach { task_id }`: the wait request resolves with `{ detached: true, task_id, state }`, while the underlying shell task keeps running and can later be waited again.
- RPC `shell.wait` also uses a bounded attached-wait window (`wait_timeout_seconds`, default 120, max 300) and returns the normal task shape plus `still_running: true` when the task remains active at the end of that window.
- Runtime task substrate is in `src/tasks/`: `TaskManager` serializes registry mutations, recovers orphaned running tasks on startup, reconciles stale nonterminal tasks again on `list`/`status` observation, and cancels owned tasks on normal shutdown.
