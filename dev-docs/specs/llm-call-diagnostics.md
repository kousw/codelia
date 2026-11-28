# LLM Call Diagnostics Spec (per-request usage/cache/cost)

This document defines a lightweight diagnostics layer for per-LLM-call visibility,
especially cache hit/miss behavior.

Status (as of 2026-11-28):
- **Implemented**: always-on `run.metrics` and `run.summary` notifications, read-only
  `telemetry.get` RPC, compact `llm.usage` persistence, live `Alt+H` Telemetry bar,
  `Alt+P`/`/perf` live footer, `/stats` (`/diag`) scrollable panel, and
  `--diagnostics` / `CODELIA_DEBUG=diagnostics` transcript expansion (B-009, B-026, B-027).
- **Planned**: live in-flight TPS updates during active token generation and optional
  per-run diagnostics toggle.
- Evidence: `packages/runtime/src/rpc/run.ts`, `packages/runtime/src/rpc/run-metrics.ts`,
  `packages/runtime/src/rpc/telemetry.ts`, `crates/tui/src/app/runtime/parser/`,
  `crates/tui/src/app/view/ui/`, `packages/runtime/tests/run-diagnostics.test.ts`,
  and protocol fixtures.

---

## 1. Goals

- Show per-request LLM diagnostics (model, latency, usage, cache hit/miss).
- Keep telemetry structured and compact (`run.metrics` / `run.summary` / `telemetry.get`),
  with detailed transcript output opt-in (`--diagnostics` or `CODELIA_DEBUG=diagnostics`).
- Derive live telemetry from in-memory `llm.request` / `llm.response` records.

Non-goals:
- Dumping raw provider payloads by default.
- Flooding the normal transcript with per-call tables without opt-in.

---

## 2. Scope boundary

### 2.1 Always-on summary & panel telemetry (Implemented)

Collection is always active via `run.metrics`, `run.summary`, and `telemetry.get`
without adding default transcript noise. Normal UI shows duration and latest TPS in
`Info` mode, while `Alt+H` cycles into the 1-line `Telemetry` status bar and
`/stats` (`/diag`) shows cumulative session/run breakdowns:

- total calls
- input/output/total tokens
- cached input tokens total
- cache creation tokens total
- total cost (when list pricing is available)

### 2.2 Diagnostics transcript mode (`--diagnostics` / `CODELIA_DEBUG=diagnostics`, Implemented)

`run.metrics` notifications carry full per-call records (`run_id`, `seq`, `provider`, `model`,
`request_ts`, `response_ts`, `latency_ms`, timing, `stop_reason`, token breakdown, cache state,
cost, retries, and `provider_meta_summary`). When diagnostics transcript mode is enabled,
the TUI renders compact per-call and run-summary transcript lines showing `provider`,
`latency_ms`, `stop_reason`, token breakdown (`in`/`out`/`total`), cache state and
`read`/`ratio`/`create` counts, plus optional `ttft`, `tps`, `cost`, `retries`, and
`provider_meta_summary`.

---

## 3. Data model

```ts
export type CacheHitState = "hit" | "miss" | "unknown";

export type LlmCallDiagnostics = {
  run_id: string;
  seq: number;
  provider?: string;
  model: string;
  request_ts: string;  // ISO8601
  response_ts: string; // ISO8601
  latency_ms: number;
  timing?: {
    time_to_first_token_ms: number;
    generation_duration_ms: number;
    generation_start_ms?: number;
    generation_start_source?: "reasoning_item";
  };
  output_tokens_per_second?: number | null;
  stop_reason?: string | null;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    output_reasoning_tokens?: number | null;
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
```

Derived fields:

- `cache.hit_state = "hit"` when `input_cached_tokens > 0`
- `cache.hit_state = "miss"` when usage exists and `input_cached_tokens === 0`
- `cache.hit_state = "unknown"` when usage is unavailable
- `cache.cache_read_ratio = input_cached_tokens / max(input_tokens, 1)` when usage exists

---

## 4. Runtime capture rules

1. Capture `llm.request` and `llm.response` per `seq`.
2. Compute `latency_ms = response_ts - request_ts`.
3. Build `LlmCallDiagnostics` record with normalized usage fields.
4. If cost tracking is enabled, include `cost_usd`; otherwise `null`/omit.
5. Never fail a run due to diagnostics build failure (best-effort only).

Notes:
- Existing session records already include enough inputs for v1.
- v1 does not require a new JSONL record type.

### 4.1 Persistence policy (implemented, updated 2026-11-14)

- Derive diagnostics in-memory from `llm.request` / `llm.response` before disk filtering.
- Normal stores persist compact `llm.usage` accounting, independently under
  `<storage-root>/usage/`, without messages or opaque provider payloads.
- Full request/response/tool records are written only when `CODELIA_DEBUG=session-dump`,
  separately under `sessions/diagnostics/`; this flag is independent of display diagnostics.
- Emit structured `run.metrics` and `run.summary` notifications unconditionally;
  `--diagnostics` / `CODELIA_DEBUG=diagnostics` controls transcript expansion in the UI.

### 4.2 Observed streaming generation rate (implemented)

- `ChatInvokeCompletion.timing` and in-memory `llm.response.output.timing` carry
  optional monotonic timing for the successful transport attempt. The compact
  `llm.usage.output.timing` retains the same measurements without full payloads.
- `time_to_first_token_ms` measures transport start to the first nonempty output
  delta. Lifecycle, role-only, empty, signature and usage-only events do not start
  the first-delta clock. Text, refusal, reasoning and function-argument deltas do.
- For Responses streams, an earlier `response.output_item.added` reasoning item
  starts observed generation activity, even when its content stays encrypted.
  Record this separately as `generation_start_ms` / `generation_start_source`;
  do not start on response.created, metadata or empty assistant items.
- Google Interactions uses the first `step.start` with `type: thought` as the
  observed reasoning activity marker (`generation_start_source: thought_step`).
  Create the tracker before awaiting SDK request setup. Nonempty model-output
  text or function arguments supplied in a step-start snapshot also count as
  first output; lifecycle/empty items and thought signatures do not.
- `generation_duration_ms` measures the earlier of observed reasoning activity
  and first nonempty output to the terminal event
  (or stream end for Chat Completions). SDK final-response restoration and debug
  dumps after completion are excluded. Retries, WS reconnects and HTTP fallback
  use fresh trackers; abandoned attempts never contribute to successful timing.
- `output_tokens_per_second = usage.output_tokens * 1000 / generation_duration_ms`.
  Missing usage/timing, invalid values or an interval shorter than 250ms produce
  `null`. Responses usage preserves `output_reasoning_tokens`. When it is positive
  but an observed reasoning start is unavailable, suppress the rate rather than
  divide hidden reasoning tokens by visible-output time.
  Never estimate tokens from characters or count SSE chunks as tokens.
- This is an **observed stream rate**, not server-side decode throughput.
  A reasoning-item/thought-step start is an activity marker, not an exact first-token timestamp.
  Provider output usage can include hidden reasoning. Summaries, chunk buffering
  and provider-hosted tools can therefore affect comparability across models.
- OpenAI HTTP/WS, OpenRouter, named Responses/DeepSeek, Google, xAI, Moonshot, Z.ai and Anthropic
  collect timing. Anthropic uses SDK streaming for both normal and Fast paths,
  restoring the same complete message before committing history.
- Normal-mode `run.metrics` notifications report each completed call,
  independently of the diagnostics flag. They contain no output payload and
  are not persisted separately. Older/custom adapters may omit timing.
- Provider additions/transport migrations must test normalized provider usage
  and timing through runtime `buildRunMetrics`, including reasoning and tool
  turns. Adapter timing presence alone does not prove that UI metrics work.
  Shared fixtures live in `packages/runtime/tests/provider-metrics.test.ts`;
  Google thought/text/tool/snapshot cases live in `google-metrics.test.ts`.
- Live TUI updates during token generation remain planned. The current TUI
  shows `TPS: 42.1` after a measured call finishes and retains that last known
  value across calls and runs until a replacement measurement arrives.
  Missing/null metrics do not erase it. Remaining context follows the same
  retention policy; starting a new turn does not hide the last measured value.

Evidence: `packages/core/src/llm/stream-timing.ts`, provider adapters,
`packages/core/tests/stream-timing.test.ts`, `stream-timing-adapters.test.ts`,
`packages/runtime/src/rpc/run-metrics.ts` and `tests/run-metrics.test.ts`.

---

## 5. Protocol surface (implemented)

Legacy `run.diagnostics` / `supports_run_diagnostics` have been replaced by
always-on structured telemetry notifications plus a read-only pull RPC:

1. **`run.metrics`** (Runtime → UI, always emitted after every completed LLM call):
   carries `provider`, `model`, `actual_model?`, `request_ts`, `response_ts`,
   `latency_ms`, `timing` (TTFT + generation duration), `output_tokens_per_second`,
   `stop_reason`, `usage` (including reasoning/image/cached/cache-create tokens),
   `cache` (`hit_state`, `cache_read_tokens`, `cache_creation_tokens`, `cache_read_ratio`),
   `cost_usd`, `cost_basis` (`"api_list" | "unavailable"`), `retry_count`, `retry_wait_ms`,
   `provider_meta_summary`, scalar `context`, and authoritative cumulative `session: TelemetrySummary`
   (so clients display runtime totals directly without duplicating aggregation).
2. **`run.summary`** (Runtime → UI, always emitted at run completion):
   carries `run_id`, `duration_ms`, per-run `run: TelemetrySummary`, and
   session-scoped cumulative `session: TelemetrySummary` (survives `invalidateAgentCache()`),
   including exact `cache_hit_calls` / `cache_miss_calls` / `cache_unknown_calls`,
   tool `exec_duration_ms` vs `approval_wait_ms`, retry totals, compaction totals, and `by_model`.
3. **`telemetry.get`** (UI → Runtime, read-only pull RPC behind `supports_telemetry`):
   returns `session_id`, `active_run_id`, `context` (with category breakdown),
   `session_summary`, `run_summary`, `recent_calls` (64), `recent_tools` (64),
   and `runtime` (`startup_phases`, `agent_init_phases`, `active_subagents`,
   `max_concurrent_subagents`, `backpressure_events`, `memory`).

---

## 6. Rendering requirements

### 6.1 Normal mode & quick toggles (implemented)

- `StatusLineMode::Info` shows latest completed-call TPS and context left %.
- `Alt+H` cycles `Info -> Telemetry -> Help`, providing a 1-line compact
  `Telemetry` status bar (TPS, TTFT/latency, cache hit ratio, session tokens,
  optional cost, context %) with zero layout height change.
- `Alt+P` / `/perf [on|off|toggle]` toggles the 2-line live Telemetry + TUI Perf
  footer bar.
- `/stats` (alias `/diag`) opens a read-only scrollable telemetry panel backed
  by local stores and refreshed via `telemetry.get`.

### 6.2 Diagnostics transcript mode (implemented)

- `--diagnostics` or `CODELIA_DEBUG=diagnostics` expands always-on `run.metrics`
  and `run.summary` notifications into compact per-call and cumulative transcript
  status lines using exact cache hit/miss/unknown call counts.

---

## 7. Provider notes

- OpenAI: cache read is mapped to `input_cached_tokens` when provided.
- Anthropic: read/create tokens map to `input_cached_tokens` and `input_cache_creation_tokens`.
- Providers without cache metrics report `hit_state: "unknown"` unless normalized usage clearly indicates `0`.
- Across all providers, normalized `input_tokens` equals total input tokens (uncached + cached read + cache creation); cost estimation accounts for this when subtracting cached/creation tokens from base input pricing, and sets `cost_usd: null` (`cost_basis: "unavailable"`) for non-metered OAuth routes or unknown pricing.
- `cost_basis: "api_list"` is a standard-tier list-price estimate: it does not add fast/priority-tier surcharges, >200K long-context tier multipliers, or extended cache-TTL write multipliers. When a session mixes priced and unpriced models, cumulative `total_cost_usd` sums only calls with available pricing.

---

## 8. Rollout status

1. Always-on `run.metrics` and `run.summary` notifications are implemented in runtime.
2. Read-only `telemetry.get` pull RPC (`supports_telemetry`) is implemented in runtime and protocol codegen.
3. TUI always-on telemetry + perf ring-buffer stores, `Alt+H` Telemetry mode, `Alt+P` / `/perf` bar, `/stats` (`/diag`) panel, and `--diagnostics` transcript expansion are implemented.

---

## 9. Open questions

- Should diagnostics be toggleable per-run (`run.start.meta.diagnostics=true`) in addition to process flag?
- Should `provider_meta_summary` include redaction rules per provider?
- Do we need a persisted precomputed record (`llm.call`) later for offline analysis speed?
