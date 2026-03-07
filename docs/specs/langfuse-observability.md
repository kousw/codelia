# Langfuse Observability Integration Spec

This document defines a Langfuse-first observability integration for Codelia.
The integration is optional and must remain a no-op when disabled or misconfigured.

Status (as of 2026-03-07):
- Planned (spec only)
- Initial backend target: `langfuse`
- Future extension point: additional backends may be added later, but are out of scope for this document

---

## 1. Goals

- Export Codelia run/LLM/tool execution metadata to Langfuse for trace inspection.
- Reuse existing runtime/core signals wherever possible:
  - `run.start` / `run.status` / `run.end`
  - `agent.event`
  - `llm.request` / `llm.response`
  - `tool.output`
  - `run.diagnostics` when available
- Preserve the current architecture rule that observability is optional and falls back to no-op.
- Keep the integration best-effort only: observability failure must not fail a user run.
- Support Langfuse trace correlation for:
  - run lifecycle
  - LLM calls
  - tool calls
  - MCP-backed tool calls (as tool spans with MCP metadata when available)

Non-goals:
- Defining a generic multi-backend exporter API in v1.
- Syncing prompt management assets to Langfuse.
- Backfilling historical JSONL sessions into Langfuse.
- Persisting new session record types only for Langfuse.
- Making Langfuse mandatory for local CLI/TUI usage.

---

## 2. Scope

### 2.1 In scope (v1)

- Runtime-side optional Langfuse client initialization.
- One Langfuse trace per Codelia `run_id`.
- One Langfuse generation/observation per `llm.request` + `llm.response` pair.
- One Langfuse span per tool call (`tool_call_id`).
- Final run outcome/status update on `run.end`.
- Configurable capture policy for inputs/outputs/metadata.
- Bounded shutdown flush so runtime exit does not hang indefinitely.

### 2.2 Out of scope (v1)

- UI changes dedicated to Langfuse.
- Historical replay/import jobs.
- Per-provider custom exporters beyond Langfuse.
- Langfuse prompt registry, datasets, scores, or eval orchestration.
- OTLP exporter work (keep implementation seam open, but do not spec it here).

---

## 3. Configuration

Add optional runtime config keys under `observability.*`.
Secrets should not be stored directly in project config; config should point to env var names.

```json
{
  "observability": {
    "provider": "none | langfuse",
    "sample_rate": 1,
    "capture_input": "none | redacted | full",
    "capture_output": "none | redacted | full",
    "langfuse": {
      "base_url": "https://cloud.langfuse.com",
      "public_key_env": "LANGFUSE_PUBLIC_KEY",
      "secret_key_env": "LANGFUSE_SECRET_KEY",
      "release": null,
      "flush_timeout_ms": 2000,
      "debug": false
    }
  }
}
```

Defaults:
- `observability.provider = "none"`
- `observability.sample_rate = 1`
- `observability.capture_input = "redacted"`
- `observability.capture_output = "redacted"`
- `observability.langfuse.base_url = "https://cloud.langfuse.com"`
- `observability.langfuse.public_key_env = "LANGFUSE_PUBLIC_KEY"`
- `observability.langfuse.secret_key_env = "LANGFUSE_SECRET_KEY"`
- `observability.langfuse.flush_timeout_ms = 2000`
- `observability.langfuse.debug = false`

Runtime behavior:
1. If `observability.provider != "langfuse"`, Langfuse integration is disabled.
2. If provider is `langfuse` but required credentials are missing, integration is disabled and runtime logs one debug-level reason.
3. If `sample_rate <= 0`, integration is disabled for the run.
4. If sampled out, no Langfuse trace/span objects are created for that run.

---

## 4. Data model and mapping

### 4.1 Trace identity

- Use one Langfuse trace per `run_id`.
- Set the Langfuse trace/session identifier from Codelia `session_id` when available.
- Use stable metadata fields:
  - `run_id`
  - `session_id`
  - `runtime.cwd` (if available)
  - `model.provider`
  - `model.name`
  - `client.name` / `client.version`
  - `server.name` / `server.version`
  - `approval_mode` when available in run metadata

### 4.2 Root trace payload

Create the trace from `run.start`.

Preferred mappings:
- Trace name: `codelia.run`
- User-facing input:
  - from `run.start.input`
  - subject to capture/redaction policy
- Metadata:
  - normalized header/runtime/model/tool count/context metadata
- Tags:
  - provider (`openai`, `anthropic`, `openrouter`, etc.)
  - model id
  - `cli` / `tui` / future client name when known

Update/finalize the trace on `run.end`:
- `completed` -> success
- `cancelled` -> cancelled status
- `error` -> error status with error metadata if available
- final output text -> from `run.end.final` when capture policy allows it

### 4.3 LLM call mapping

For each matched `llm.request` / `llm.response` pair sharing the same `run_id` and `seq`:

- Create one Langfuse generation/observation.
- Observation name: `llm.call`
- Observation id key: `run_id + ":llm:" + seq`
- Start time: `llm.request.ts`
- End time: `llm.response.ts`
- Model/provider:
  - prefer `llm.request.model.provider`
  - prefer `llm.request.model.name`
  - fall back to input `model` when needed
- Input:
  - normalized request messages
  - tool definitions summary (not raw schema by default)
  - tool choice when present
  - subject to capture/redaction policy
- Output:
  - normalized response messages or final assistant content summary
  - stop reason
  - subject to capture/redaction policy
- Usage:
  - `input_tokens`
  - `output_tokens`
  - `total_tokens`
  - `input_cached_tokens`
  - `input_cache_creation_tokens`
  - `input_image_tokens`
- Cost:
  - include `cost_usd` when available from diagnostics/usage layer
- Extra metadata:
  - `seq`
  - `cache_hit_state`
  - `latency_ms`
  - safe provider metadata summary (never raw provider payload by default)

If `run.diagnostics` is enabled, runtime may reuse its normalized cache/cost fields instead of recomputing them independently.
If diagnostics are disabled, Langfuse export should derive the minimum required values directly from `llm.request` and `llm.response`.

### 4.4 Tool mapping

For each tool lifecycle:

- Open a Langfuse span on `agent.event` with `type: "tool_call"`.
- Span name: `tool.exec`
- Span id key: `run_id + ":tool:" + tool_call_id`
- Metadata:
  - `tool`
  - `tool_call_id`
  - `display_name` when available
  - `step_id` if correlated from surrounding step events
  - `is_hosted_search` when tool display/type indicates hosted search
  - `mcp.server` / `mcp.tool` when runtime can resolve MCP origin
- Input:
  - tool args (`args`/`raw_args`) subject to capture/redaction policy
- Output:
  - prefer `tool_result.result`
  - fall back to `tool.output.result_raw` if needed for flush-after-run completeness
  - omit screenshots/base64 payloads by default unless capture policy is `full`
- Status:
  - success on normal `tool_result`
  - error when `tool_result.is_error === true`

Correlation rules:
- `tool_call` starts the span.
- `tool_result` closes the span.
- `step_complete(status="error")` may mark the active step/tool span as error if no `tool_result` was emitted.
- Runtime must tolerate missing close events and flush incomplete spans as errored/aborted on run termination.

### 4.5 Step mapping

`step_start` / `step_complete` are optional in v1.
If implemented, they should be nested spans named `agent.step`.
If omitted, tool/LLM observations are still sufficient for the first release.

---

## 5. Capture and redaction policy

The capture policy is global for v1.

### 5.1 `capture_input`

- `none`: do not send prompt/tool input bodies to Langfuse.
- `redacted`: send structured input with sensitive fields removed or masked.
- `full`: send full normalized input bodies, subject only to hard safety exclusions.

### 5.2 `capture_output`

- `none`: do not send tool/assistant output bodies to Langfuse.
- `redacted`: send structured output with sensitive fields removed or masked.
- `full`: send full normalized output bodies, subject only to hard safety exclusions.

### 5.3 Hard safety exclusions

Regardless of `full`, runtime must omit or replace the following:
- auth headers and bearer tokens
- values under keys matching common secret labels (`api_key`, `secret`, `token`, `password`, `cookie`, `authorization`)
- image `data:` URLs
- `screenshot_base64`
- raw OAuth tokens / refresh tokens / MCP auth payloads

### 5.4 Redacted mode rules

In `redacted` mode, runtime should additionally:
- truncate long text fields to a bounded length
- summarize tool schemas instead of exporting full JSON Schema bodies
- convert provider-specific metadata payloads to short summaries
- prefer `output_ref` or summary text over raw large tool blobs when available

---

## 6. Runtime lifecycle and ownership

### 6.1 Initialization

- Runtime resolves observability config during startup or agent factory creation.
- Langfuse client is constructed lazily only when the first sampled run starts.
- If client construction fails, runtime records one debug log and continues without observability.

### 6.2 Per-run state

Runtime keeps ephemeral in-memory state keyed by `run_id`:
- Langfuse trace handle/reference
- pending LLM request state by `seq`
- pending tool span state by `tool_call_id`
- sampled/not-sampled decision

This state must not be persisted into session records.

### 6.3 Flush behavior

- Flush when `run.end` arrives.
- Also flush on runtime shutdown/before process exit when practical.
- Bound flush time with `observability.langfuse.flush_timeout_ms`.
- Flush timeout/failure must not change run outcome.

---

## 7. Failure policy

The integration is best-effort only.

Rules:
1. Langfuse errors must never fail `run.start`, `runStream`, tool execution, or `run.end`.
2. Export failures should be logged only in debug/diagnostic mode.
3. Missing/malformed observability state should cause span/trace drop, not agent failure.
4. When request/response pairs are incomplete, export the available side with partial metadata only if Langfuse SDK allows it safely; otherwise drop the incomplete observation.
5. Runtime should avoid unbounded memory growth from stuck pending spans/observations by cleaning them up on run termination.

---

## 8. Session/protocol interaction

- Do not introduce new session JSONL record types for Langfuse.
- Do not modify the prompt-visible history for observability purposes.
- Do not require new UI protocol notifications for Langfuse v1.
- `run.diagnostics` remains UI-facing and optional.
- Langfuse export should consume the same normalized data already produced for diagnostics where beneficial, but without making diagnostics mode a prerequisite.

---

## 9. Suggested implementation shape

Recommended layering for v1:

1. Add a small runtime-local observability service interface:
   - `onRunStart(record)`
   - `onRunStatus(record)`
   - `onRunEnd(record)`
   - `onAgentEvent(record)`
   - `onLlmRequest(record)`
   - `onLlmResponse(record)`
   - `onToolOutput(record)`
2. Provide:
   - `NoopObservabilityService`
   - `LangfuseObservabilityService`
3. Feed the service from the same runtime/session hooks already used for diagnostics/session logs.
4. Keep provider-specific request serializers unaware of Langfuse.

This keeps the first integration Langfuse-specific while preserving a clean seam for future exporters.

---

## 10. Rollout plan

1. Add config wiring and a no-op/disabled default path.
2. Create runtime-local Langfuse service and trace lifecycle handling.
3. Export root run traces plus LLM observations.
4. Export tool spans.
5. Add focused tests for:
   - disabled config -> no-op
   - missing credentials -> no-op
   - one LLM request/response pair -> one generation observation
   - tool call/result pair -> one tool span
   - run error/cancel -> trace finalized without affecting runtime behavior
6. Optionally document a minimal `.env` setup for local verification.

---

## 11. Open questions

- Should `observability.provider` live only in global/project config, or also accept `CODELIA_OBSERVABILITY_PROVIDER` env override?
- Should per-run opt-in/out be allowed through `run.start.meta`, or remain process/project scoped in v1?
- Should `session_id` map to Langfuse `sessionId`, `userId`, or metadata only?
- Do we want `permission.preview` / `permission.ready` spans in a later phase for approval latency analysis?
- Should MCP server identity be added explicitly to tool metadata in runtime records for more accurate Langfuse grouping?
