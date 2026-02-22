# LLM Call Diagnostics Spec (per-request usage/cache/cost)

This document defines a lightweight diagnostics layer for per-LLM-call visibility,
especially cache hit/miss behavior.

Status (as of 2026-02-19):
- Planned (spec only)
- Scope target: backlog **B-009**, **B-026**, **B-027**

---

## 1. Goals

- Show per-request LLM diagnostics (model, latency, usage, cache hit/miss).
- Keep a clear boundary:
  - **B-009**: always-visible run summary (usage/cost)
  - **B-026/B-027**: opt-in detailed diagnostics
- Reuse existing persisted records (`llm.request`, `llm.response`) where possible.

Non-goals:
- Dumping raw provider payload by default.
- Making diagnostics mandatory for normal TUI flow.

---

## 2. Scope boundary (B-009 vs B-026/B-027)

### 2.1 Always-visible (`B-009`)

Show a compact run summary after terminal status:

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
  stop_reason?: string | null;
  usage?: {
    input_tokens: number;
    output_tokens: number;
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

### 4.1 Persistence policy (v1)

- Do not add new persisted message/event records for diagnostics.
- Derive diagnostics in-memory from existing `llm.request` / `llm.response`.
- Emit diagnostics to UI as optional runtime notifications only.
- If diagnostics mode is off, do not emit diagnostics notifications.

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

- Keep current behavior.
- Optionally show only one compact final usage/cost summary (B-009 scope).

### 6.2 Diagnostics mode

Show a per-call list/table. Minimum columns:

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

## 8. Rollout plan

1. Runtime derives per-call diagnostics from `llm.request`/`llm.response`.
2. Runtime emits `run.diagnostics` (`kind: "llm_call"`).
3. Runtime emits final `run_summary` diagnostics payload.
4. TUI adds diagnostics panel/section behind a flag.

---

## 9. Open questions

- Should diagnostics be toggleable per-run (`run.start.meta.diagnostics=true`) in addition to process flag?
- Should `provider_meta_summary` include redaction rules per provider?
- Do we need a persisted precomputed record (`llm.call`) later for offline analysis speed?
