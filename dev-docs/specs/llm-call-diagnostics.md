# LLM Call Diagnostics Spec (per-request usage/cache/cost)

This document defines a lightweight diagnostics layer for per-LLM-call visibility,
especially cache hit/miss behavior.

Status (as of 2026-10-17):
- Partial: per-call diagnostics and final diagnostic usage summaries are implemented
  behind `--diagnostics`; the normal-mode TPS status display is implemented.
- Planned: a dedicated diagnostics table/panel and an opt-in full
  usage/cost run summary.
- Scope target: backlog **B-009**, **B-026**, **B-027**
- Evidence: `packages/runtime/src/rpc/run.ts`, `packages/runtime/src/rpc/run-metrics.ts`,
  `crates/tui/src/app/runtime/parser.rs`, `crates/tui/src/app/view/ui/status.rs`;
  `packages/runtime/tests/run-diagnostics.test.ts`.

---

## 1. Goals

- Show per-request LLM diagnostics (model, latency, usage, cache hit/miss).
- Keep a clear boundary:
  - **B-009**: opt-in run summary (usage/cost)
  - **B-026/B-027**: opt-in detailed diagnostics
- Derive live diagnostics from in-memory `llm.request` / `llm.response` records.

Non-goals:
- Dumping raw provider payload by default.
- Making diagnostics mandatory for normal TUI flow.

---

## 2. Scope boundary (B-009 vs B-026/B-027)

### 2.1 Optional run summary (`B-009`)

Proposed: show a compact run summary only when explicitly requested. Collection
and display are separate policies; adding accounting does not enable default
transcript output. This summary is outside the current Steer implementation.

Planned: the complete usage/cost summary below. Current normal mode shows run
duration and the most recently completed model call's TPS in the status line.

- total calls
- input/output/total tokens
- cached input tokens total
- cache creation tokens total
- total cost (if available)

### 2.2 Diagnostics mode (`B-026/B-027`)

When diagnostics mode is enabled (for example `--diagnostics`), show per-call details:

- call sequence (`seq`)
- provider/model
- request/response timestamps
- latency
- stop reason
- token usage breakdown
- cache read/write indicators
- optional per-call cost
- optional provider metadata summary

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
- Full request/response/tool records are written only when `CODELIA_SESSION_DUMP=1`,
  separately under `sessions/diagnostics/`; this flag is independent of display diagnostics.
- Emit diagnostics to UI as optional runtime notifications only.
- If diagnostics mode is off, do not emit diagnostics notifications.

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

## 5. Protocol extension

Add optional notification method:

```ts
// Runtime -> UI
method: "run.diagnostics"
params:
  | {
      run_id: string;
      kind: "llm_call";
      call: LlmCallDiagnostics;
    }
  | {
      run_id: string;
      kind: "run_summary";
      summary: UsageSummary;
    };
```

Compatibility:
- Older UIs can ignore unknown method `run.diagnostics`.
- Older runtimes simply do not emit the method.

---

## 6. Rendering requirements

### 6.1 Normal mode

- Show latest completed-call TPS in the status line when available.
- Optionally show only one compact final usage/cost summary (B-009 scope).

### 6.2 Diagnostics mode

Current: compact per-call status lines with optional TPS. Planned: a dedicated
per-call list/table. Minimum columns:

- `seq`
- `model`
- `latency_ms`
- `input/output/total`
- `cached` (`input_cached_tokens`)
- `cache_create` (`input_cache_creation_tokens`)
- `cache_hit` (`hit|miss|unknown`)
- `cost_usd` (if available)
- `stop_reason`

For narrow layouts, row expansion is acceptable as long as fields remain structured.

---

## 7. Provider notes

- OpenAI: cache read is mapped to `input_cached_tokens` when provided.
- Anthropic: read/create tokens map to `input_cached_tokens` and `input_cache_creation_tokens`.
- Providers without cache metrics should report `hit_state: "unknown"` unless normalized usage clearly indicates `0`.

---

## 8. Rollout status

1. Runtime derives per-call diagnostics from `llm.request`/`llm.response`.
2. Runtime emits `run.diagnostics` (`kind: "llm_call"`).
3. Runtime emits final `run_summary` diagnostics payload.
4. TUI compact diagnostics lines and normal-mode TPS are implemented;
   a dedicated diagnostics panel remains planned.

---

## 9. Open questions

- Should diagnostics be toggleable per-run (`run.start.meta.diagnostics=true`) in addition to process flag?
- Should `provider_meta_summary` include redaction rules per provider?
- Do we need a persisted precomputed record (`llm.call`) later for offline analysis speed?
