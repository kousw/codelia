# OpenAI WebSocket Mode (Experimental) Spec

## 0. Status

- Status: Planned (Experimental)
- Date: 2026-02-24
- Related:
  - `docs/specs/providers.md`
  - `docs/specs/agent-loop.md`
  - `packages/core/src/llm/openai/chat.ts`

This document defines an experimental integration of OpenAI Responses WebSocket mode for `ChatOpenAI`, while keeping current behavior and safety guarantees.

---

## 1. Problem Statement

Current OpenAI path in core:

- Uses `responses.stream(...).finalResponse()` per invoke.
- Re-sends full serialized history (`BaseMessage[]`) each iteration.
- Does not use `previous_response_id` chaining.
- Works correctly, but introduces repeated request overhead during tool-heavy loops.

OpenAI WebSocket mode can reduce repeated request overhead by keeping a session-oriented chain, but it does not naturally match codelia's current stateless invoke shape.

---

## 2. Goals

1. Add optional OpenAI WebSocket mode for lower latency/overhead in multi-step runs.
2. Preserve correctness of existing agent behavior and history semantics.
3. Keep OpenAI integration backward-compatible and easy to disable.
4. Isolate transport-specific state from authoritative history.

---

## 3. Non-goals (phase 1)

1. Changing Agent loop semantics (`run` / `runStream` event order).
2. Changing protocol payloads (`agent.event`, `run.status`, etc.).
3. Applying WebSocket transport to non-OpenAI providers.
4. Replacing existing HTTP/SSE path (must remain available as fallback).

---

## 4. Design Principles

### 4.1 Two-layer state model

Keep two distinct layers:

- **Authoritative history**: existing `BaseMessage[]` managed by history adapter.
- **Transport optimization state**: OpenAI chain/session state (`previous_response_id`, socket/session info).

Authoritative history remains source of truth. Transport state is disposable optimization.

### 4.2 Safety-first reset

If chain continuity is uncertain, reset chain and continue with full-history invoke.

---

## 5. Config and Flag Surface

Add provider-scoped experimental flag under top-level `experimental` config.

Proposed config (exact loader wiring follows implementation):

```json
{
  "model": {
    "provider": "openai",
    "name": "gpt-5"
  },
  "experimental": {
    "openai": {
      "websocket_mode": "off"
    }
  }
}
```

`experimental.openai.websocket_mode` enum:

- `off` (default): always use existing HTTP/SSE invoke path.
- `auto`: prefer WebSocket mode, fallback to HTTP/SSE on unsupported/error states.
- `on`: require WebSocket mode; if unavailable, return provider error (no silent fallback).

Phase 1 default stays `off`.

---

## 6. Core Adapter Architecture

### 6.1 `ChatOpenAI` transport split

`ChatOpenAI` keeps one public `ainvoke(...)` contract and selects transport internally:

- `http_stream` (existing): `responses.stream(...).finalResponse()`.
- `ws_mode` (new): WebSocket session path with response chaining.

### 6.2 Conversation state key

Maintain state per logical conversation key:

- Primary key: `context.sessionKey`.
- If absent: do not use ws chaining state (fall back to stateless behavior).

Proposed internal state includes:

- `previousResponseId?: string`
- `historyEpochAtLastSync: number`
- `modelId`
- `toolsHash`
- `instructionsHash`
- `lastUsedAt`

---

## 7. History Reconstruction / Compaction Rules

This is the critical safety section.

### 7.1 Chain reset triggers (mandatory)

Reset WebSocket chain state when any of the following occurs:

1. History reconstruction happened (compaction replaced history).
2. `replaceHistoryMessages(...)` called.
3. Model changed.
4. System instructions changed.
5. Tool schema set changed.
6. OpenAI reports invalid/missing `previous_response_id`.
7. Transport reconnect where continuity cannot be guaranteed.

Reset action:

- Clear `previousResponseId`.
- Next request sends full serialized history.
- Successful response establishes a new chain root.

### 7.2 History epoch hint

Extend invoke context with an epoch hint (proposed):

- Agent increments epoch whenever authoritative history is structurally rebuilt.
- OpenAI adapter resets chain if epoch differs from last synchronized epoch.

This avoids inferring reconstruction from heuristics.

---

## 8. Error Handling and Fallback

### 8.1 `auto` mode behavior

When ws-mode invocation fails in a recoverable way:

- Log transport failure in provider diagnostics.
- Reset chain state.
- Retry once via full-history path (ws or HTTP path depending on failure class).
- If still failing, return provider error.

### 8.2 `on` mode behavior

No silent fallback to HTTP path.

- Return explicit provider error with actionable message.
- Keep authoritative history unchanged.

### 8.3 In-flight constraint

WebSocket mode assumes one in-flight request per connection/session.

- Do not multiplex concurrent in-flight model calls on one socket.
- If concurrency is needed, allocate separate conversation state/connection.

---

## 9. Diagnostics

Provider diagnostics should include transport and chain metadata:

- `transport=http_stream|ws_mode`
- `chain_reset=true|false` + `reason`
- `previous_response_id_present=true|false`
- `fallback_used=true|false`
- `ws_reconnect_count`

Do not log secrets or raw auth headers.

---

## 10. Compatibility Requirements

1. Existing OpenAI behavior is unchanged when flag is `off`.
2. Session storage and replay format remain unchanged.
3. Agent events and runtime protocol remain unchanged.
4. OpenRouter connector behavior remains unaffected.

---

## 11. Testing Plan

### 11.1 Core unit tests (`packages/core/tests`)

1. Transport selection by flag (`off/auto/on`).
2. Chain reuse on stable session (no reconstruction).
3. Chain reset on epoch change.
4. Chain reset on tool/instruction/model hash drift.
5. `auto` fallback path on recoverable ws errors.
6. `on` hard-fail behavior without fallback.

### 11.2 Agent integration behavior

1. Tool-call loops preserve final responses and history commits.
2. Compaction followed by next turn triggers full-history restart.
3. `runStream` event sequence is unchanged.

### 11.3 Regression checks

- `bun run typecheck`
- Focused `bun test packages/core/tests`

---

## 12. Rollout Plan

### Phase 0 (spec + prep)

- Land this spec.
- Add config parsing/type support for experimental flag.

### Phase 1 (internal experimental)

- Implement ws-mode transport path in `ChatOpenAI` behind `off` default.
- Add diagnostics and reset/fallback behavior.
- Add unit tests.

### Phase 2 (`auto` trial)

- Enable `auto` in controlled environments.
- Observe fallback/reconnect/reset metrics.

### Phase 3 (default decision)

- Decide default (`off` or `auto`) based on stability and measurable benefit.

---

## 13. Open Questions

1. Exact mapping of WebSocket session lifecycle to `sessionKey` TTL/eviction.
2. Whether to expose reconnect/reset counters in runtime diagnostics stream.
3. Whether compaction should always force one-turn HTTP full resend even in ws mode.
