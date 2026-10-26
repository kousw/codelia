# @codelia/protocol

Type definition for the UI protocol used between Core and UI (TUI/desktop).
Provides JSON-RPC 2.0 compatible envelopes and run/agent/ui message types.
Maintains independence from `@codelia/core`.
The cross-boundary common type refers to `@codelia/shared-types` (does not depend on core/runtime implementation type).
Contains model.list / model.set / session.list / session.history (model.list can return details with include_details).
`model.list.details` can include `release_date` and normalized cost fields (`cost_per_1m_input_tokens_usd`, `cost_per_1m_output_tokens_usd`) in addition to token limits.
run.start accepts session_id.
run.start result may include `session_log_path` for persisted session JSONL consumers such as CLI ATIF export.
run.start `input` supports both text (`{ type:"text", text }`) and multimodal parts (`{ type:"parts", parts:[text|image_url] }`).
Request-scoped client tools use `client.tool.call`; when `timeout_ms` expires, runtime emits `client.tool.cancel` with the original `request_id` before discarding the pending request so interactive clients can clear matching UI state.
Contains `mcp.list` and `supports_mcp_list` capability for MCP status display.
Includes `skills.list` and `supports_skills_list` capabilities for skills catalog retrieval.
Contains `context.inspect` and `supports_context_inspect` capabilities for taking context snapshots.
`context.inspect` can receive `include_skills`, return skills catalog status, and include the rendered `execution_environment` startup block.
Permission preflight uses structured `AgentEvent` variants (`permission.preview` / `permission.ready`). `supports_permission_preflight_events` remains on both UI/server capabilities for explicit feature declaration.
Provide `mcp-protocol.ts` (protocol version constant/compatibility check helper) for MCP transport handshake and share it with runtime/cli.

Reference specifications:
- `run.metrics` carries latest completed-call TPS independently of diagnostics;
  nullable rate clears unavailable data. Optional `LlmCallTiming` is shared-types.
- `image.ts` defines optional `image.model.get/configure` and `image.artifact.get`
  behind `supports_image_generation`. Stable image metadata comes from
  shared-types. Artifact transfer is bounded PNG bytes, not host paths; image
  settings never select the conversation model or imply account entitlement.
- dev-docs/specs/ui-protocol.md

Build:
- bun run --filter @codelia/protocol build
- Protocol includes optional `shell.exec` RPC + `supports_shell_exec` capability for TUI bang-shell flow.
- Protocol also includes shell-task compatibility RPCs (`shell.start/list/status/output/wait/detach/cancel`) plus `supports_shell_tasks` / `supports_shell_detach` for task-backed shell lifecycle UI.
- Public task orchestration RPCs are `task.spawn/list/status/wait/cancel/result`; `supports_tasks` advertises that generic task surface.

- `initialize.model_providers` and `model.list.providers` optionally advertise configured endpoint names; `model.list.reasoning_levels` advertises per-model effort arrays (empty means no reasoning). Older peers may ignore these additive fields.
- Named `auth.logout.provider` must be gated by `supports_scoped_logout`; older servers may otherwise ignore the name and clear all credentials. `clear_session` applies only to a matching current provider for scoped logout.

- `fast` uses shared `ModelFastMode` (boolean or "ultrafast"). Require `supports_model_ultrafast` before sending the new value to a runtime; results retain the exact effective mode.
