# Codex backend stream metadata

Status: Implemented for the existing OpenAI chat OAuth backend, 2026-10-17.
The new SIWC/public API flow is separate and is not substituted automatically.

Source contract inspected at [openai/codex pinned revision](https://github.com/openai/codex/blob/ce0323f2f2d3b25e82806cd555237da3db4e1897/codex-rs/codex-api/src/sse/responses.rs), including `core/src/client.rs` turn-state lifetime and TUI buffering behavior. This is a selected compatibility slice, not the complete Codex client protocol.

## Implemented

`packages/core/src/llm/openai/codex-metadata.ts` normalizes known fields from HTTP response headers and HTTP/WS stream events:

| Input | Behavior |
| --- | --- |
| `openai-model` / `x-openai-model` | Record actual server model in diagnostics and usage.provider_model. Keep configured model unchanged. |
| `openai_verification_recommendation` | Recognize `trusted_access_for_cyber`, deduplicate and emit an informational `llm.status` event. |
| `safety_buffering` / metadata.type=`safety_buffering` | Validate use_cases/reasons arrays, record counts and bounded optional retry_model, emit waiting status before assistant output. Clear on assistant output, terminal event or request teardown. |
| `openai_chatgpt_moderation_metadata` | Record presence only. Never retain/replay/display the opaque payload. |
| `x-codex-turn-state` | Keep opaque first-value routing state in memory and replay unchanged for subsequent requests in the same turn. |

HTTP header turn state wins over later event metadata. HTTP injects the routing header after SDK bearer resolution; WS captures upgrade/event headers and includes the value in handshake headers and `response.create.client_metadata`. A new run closes any prior-turn Codex WS chain before reuse. No routing token enters request-body dumps, response dumps, provider_meta, session records or prompts. WS error-header formatting redacts it.

`ChatInvokeContext.turnKey` identifies one user turn, unlike durable `sessionKey`. Agent supplies run_id when available or an ephemeral UUID once per runStream. Without turnKey, direct adapter calls do not retain/replay sticky state. Per-instance state is bounded to 16 scopes. Token-refresh JWT identity is only a cache ownership hint, never authorization. An ownership change invalidates that scope, fails before sending a continuation, and cannot trigger HTTP/model/auth fallback.

Provider status uses the optional context callback and `provider-status.ts` to reach Agent.runStream while the existing retry generator awaits inference. Early consumer close cancels pending work. Status events are display-only, outside model history and TPS timing. TUI displays fixed verification/waiting messages; it does not auto-open account settings, verify the user, replay a request or switch to a suggested faster model.

Each transport attempt resets transient model/moderation/buffering facts while keeping routing scoped to the run; verification display notices are deduplicated across fallback attempts.

Known facts persist under `provider_meta.codex_metadata` and appear in per-call diagnostics summaries. Unknown/malformed metadata is inert and must not establish success. Terminal stream failures and cancellation retain the transport error behavior.

## Intentionally unimplemented

- Native Trusted Access verification ceremonies and any automatic model retry UI.
- Interpretation or enforcement inferred from opaque moderation payloads.
- Other undocumented metadata fields; collect no raw values for these.

## Verification

Real installed SDK with mock HTTP SSE and mocked WS verifies early statuses, routing across requests/turns/auth rotation, redaction, actual model reporting, failed/cancelled streams and unchanged public API transport. TUI parser verifies status display without assistant text. Live occurrence/account verification remains manual.
