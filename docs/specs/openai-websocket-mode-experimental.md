# OpenAI WebSocket Mode (Experimental) Spec

## 0. Status

- Status: Implemented (Experimental)
- First Spec Date: 2026-02-24
- Last Updated: 2026-02-25
- Default: `experimental.openai.websocket_mode = "off"`
- Related:
  - `docs/specs/providers.md`
  - `docs/specs/agent-loop.md`
  - `packages/core/src/llm/openai/chat.ts`

This document separates current implemented behavior from planned follow-up items.

---

## 1. Current Behavior and Motivation

OpenAI in core now supports two transports behind one `ChatOpenAI.ainvoke(...)` API:

- `http_stream`: `responses.stream(...).finalResponse()`
- `ws_mode`: OpenAI Responses WebSocket transport with session chaining

WS mode reduces repeated full-history resend in stable tool loops by reusing
`previous_response_id` and sending incremental input when possible.
HTTP remains the default/safe baseline.

---

## 2. Goals

1. Provide optional WS transport for lower latency/overhead in multi-step runs.
2. Keep authoritative history semantics unchanged.
3. Keep behavior backward-compatible and easy to disable.
4. Treat transport state as disposable optimization.

---

## 3. Non-goals (current phase)

1. Changing Agent loop semantics (`run` / `runStream` ordering).
2. Changing runtime protocol payload contracts.
3. Applying WS transport to non-OpenAI providers.
4. Removing HTTP transport fallback path.

---

## 4. Design Principles

### 4.1 Two-layer state model

- **Authoritative history**: existing `BaseMessage[]` flow/history adapter
- **Transport optimization state**: WS chain/socket hints only

Authoritative history remains source of truth. WS state can be cleared anytime.

### 4.2 Safety-first reset

If chain continuity is uncertain, reset chain and send full request input.

---

## 5. Config and Flag Surface (Implemented)

Provider-scoped experimental flag:

```json
{
  "experimental": {
    "openai": {
      "websocket_mode": "off"
    }
  }
}
```

`experimental.openai.websocket_mode`:

- `off` (default): always HTTP transport
- `auto`: prefer WS and fallback to HTTP on WS failure
- `on`: require WS; no silent HTTP fallback

Implemented in:

- `packages/config/src/index.ts`
- `packages/runtime/src/agent-factory.ts`
- `packages/core/src/llm/openai/chat.ts`

---

## 6. Core Adapter Architecture (Implemented)

### 6.1 Transport selection

`ChatOpenAI` chooses transport internally:

1. `off` -> HTTP
2. `on|auto` + missing `sessionKey`:
   - `on`: throw explicit error
   - `auto`: HTTP
3. `on|auto` + `sessionKey`: WS path (with per-session state)

### 6.2 Per-session state

Current WS state tracks:

- `previousResponseId`
- `instructionsHash`
- `toolsHash`
- `model`
- `lastInput`
- `ws`
- `lastUsedAt`

Plus temporary WS-disable latch map:

- `sessionKey -> disabledUntil` (TTL-based)

Idle state is evicted by TTL and stale sockets are closed.

---

## 7. Chaining and Reset Rules

### 7.1 Implemented reset/chaining behavior

WS chaining (`previous_response_id`) is used only when all are true:

1. API mode supports chaining (`v2`)
2. Prior response id exists
3. Model/instructions/tools hash did not drift
4. Incremental input derivation succeeded
5. Existing socket is reusable (`OPEN`/`CONNECTING`)

Otherwise chain is reset and full input is sent.

On WS transport errors, per-session WS state is cleared.
Some errors temporarily disable WS for that session in `auto` mode
(`previous_response_not_found`, `could not send data`, `unexpected server response`).

### 7.2 Planned follow-up

History-epoch based reset (`historyEpochAtLastSync`) is not implemented yet.
Current logic relies on input-delta/hash/socket-state checks.

---

## 8. Error Handling, Fallback, and Cancellation

### 8.1 `auto` mode (implemented)

When WS invocation fails:

1. Clear WS state for the session.
2. Optionally set temporary WS-disable TTL for known recoverable WS-chain errors.
3. Fallback to HTTP for that invoke.

### 8.2 `on` mode (implemented)

No silent fallback to HTTP.
Errors are returned after WS state cleanup.

### 8.3 Cancellation and close semantics (implemented)

- `AbortSignal` rejects the pending WS invoke immediately.
- Abort also closes the socket.
- Socket `close` before response completion rejects the pending invoke.

This avoids waiting for `WS_RESPONSE_TIMEOUT_MS` on cancellation.

### 8.4 In-flight constraint

WS mode assumes one in-flight invoke per session/socket path.
If future multi-flight support is needed, separate state/connection management is required.

---

## 9. Diagnostics (Implemented)

Provider metadata includes:

- `transport=http_stream|ws_mode`
- `websocket_mode=off|auto|on`
- `fallback_used=true|false`
- `chain_reset=true|false`
- `ws_reconnect_count`
- `ws_input_mode=full_no_previous|full_regenerated|incremental|empty`

Provider debug logs also include request/response transport context.
Secret/auth headers are not logged.

---

## 10. Compatibility Requirements

1. Behavior remains unchanged when `websocket_mode=off`.
2. Session storage/replay format stays compatible.
3. Agent events and runtime protocol contracts are unchanged.
4. Other providers (e.g. OpenRouter) remain unaffected.

---

## 11. Test Coverage Status

Core tests cover:

1. Transport selection (`off/auto/on`)
2. Chain reuse and incremental input
3. Chain reset and full-regenerated input path
4. Fallback behavior in `auto`
5. Hard-fail behavior in `on`
6. Cancellation rejection latency path
7. Reconnect after closed/stale socket
8. Idle WS session-state eviction

Recommended checks:

- `bun run typecheck`
- `bun test packages/core/tests/openai-chat.test.ts`

---

## 12. Rollout Status

### Phase 0 (completed)

- Spec and config surface definition

### Phase 1 (completed, experimental)

- WS transport implementation behind default `off`
- Reset/fallback behavior
- Unit-test coverage for core paths

### Phase 2 (planned)

- Wider `auto` mode trials in controlled environments

### Phase 3 (planned)

- Revisit default mode (`off` vs `auto`) based on stability/benefit

---

## 13. Open Questions

1. Should runtime summary display include `ws_reconnect_count` explicitly?
2. Should compaction introduce explicit history-epoch signaling to remove heuristic resets?
