# OpenAI provider

- Uses OpenAI Responses API; message history is serialized into response input items.
- Tool calls are mapped to `function_call` items and tool outputs to `function_call_output`.
- Serialization helpers live in `serializer.ts`.
- OpenAI-specific history adapter lives in `history.ts` (canonical = response.output).
- `ResponsesWS` can throw `could not send data` if `response.create` is sent while the underlying socket is still CONNECTING; wait for socket open before first send.
- On websocket handshake `unexpected-response`, include HTTP status/headers/body in the raised error message when available so OAuth/proxy failures are diagnosable from runtime logs.
- For OAuth (`apiKey` callback), resolve client token (`prepareOptions`) before websocket handshake and merge client `defaultHeaders` (e.g. `ChatGPT-Account-ID`) into websocket headers.
- If an existing websocket chain cannot use `previous_response_id` (e.g. history was compacted and input must be regenerated), close and recreate the websocket connection before sending a fresh `response.create`.
- `invokeViaWs` must reject immediately on `AbortSignal` (and on websocket `close` before completion); closing the socket alone is not enough because the response promise may otherwise wait until timeout.
- `wsStateBySessionKey` entries are idle-evicted (close + delete) and websocket-disabled session latches are temporary (TTL) so auto mode can retry websocket after transient chain/socket failures.
- Do not reuse websocket instances whose underlying native socket is no longer OPEN/CONNECTING; force a fresh connection and reset chain metadata when the socket became stale.
- Websocket close cleanup should suppress only expected close-state failures; unexpected close errors are rethrown unless the caller is preserving an existing primary error.
- Healthy OPEN sockets survive long tool waits; the 10-minute session idle eviction is the retention bound. Do not add an eager short reuse cutoff that forces large image replay.
- Close 1009 has a transport-specific typed size failure. In `auto`, recover through the existing HTTP fallback with full logical input (no WS previous_response_id), reset the chain, and temporarily disable WS for that session. In `on`, retain non-retryable validation failure without resend/fallback, including after reconnect. Other typed provider failures remain terminal here; HTTP fallback errors propagate normally.
- `previous_response_id` chaining is only used when current input is a strict append to the last input; unchanged input forces a full regenerated `response.create`.
- In `websocket_mode=on`, timeout/closed-response websocket errors are retried once with a fresh websocket (WS-only retry; no HTTP fallback).
- OpenAI SDK `ResponsesWS` may not re-emit native socket `close`; monitor underlying `ws.socket` close events to avoid hanging until response timeout on long-lived disconnects.
- Timeout policy is split by phase: websocket connect uses a short fixed timeout, while response waiting uses an activity-based idle timeout that resets on incoming websocket events.
- Treat `response.done` as terminal success (same as `response.completed`) and only extend response idle timeout on non-terminal `response.*` progress events.
- `response-accumulator.ts` is the canonical OpenAI response restorer for both HTTP and websocket transports: rebuild `response.output` from stream events first, then merge terminal `id`/`status`/`usage` metadata so empty terminal payloads do not erase assistant text or reasoning items.
- HTTP to the fixed `https://chatgpt.com/backend-api/codex` endpoint uses SDK
  `responses.create({stream:true})` with Codelia's existing accumulator because
  Codex extension events (e.g. `response.metadata`) are outside the SDK helper's
  public event contract. Forward raw events to the observer before restoration;
  metadata is not assistant output and does not start TPS timing. Require a
  completed/incomplete terminal response, reject failures/EOF, and explicitly
  preserve `APIUserAbortError` when the raw iterator ends quietly on abort.
  Public OpenAI API, xAI and other endpoints retain `responses.stream()`.
  `codex-metadata.ts` handles selected extension semantics: actual model,
  verification recommendations, buffering status and opaque per-turn routing.
  Keep raw moderation/routing data out of prompts, session records and dumps;
  see `dev-docs/specs/providers/codex-backend-metadata.md`. Never auto-switch to
  a suggested model or infer actions from opaque moderation payloads.
- With `CODELIA_PROVIDER_LOG=1`, if `toChatInvokeCompletion()` restores no messages but `response.usage.output_tokens > 0`, emit `[openai.response.empty_completion]` followed by the raw `id/status/output_text/output/usage` JSON to help separate API behavior from serializer gaps.
- With `CODELIA_PROVIDER_LOG=1`, HTTP `responses.stream()` also emits `[openai.stream.event]` one-line JSON summaries for key SSE events (`output_text.delta`, `output_item.*`, terminal events) so final-response mismatches can be compared against the live stream.
- With `CODELIA_PROVIDER_LOG=1` or `CODELIA_DEBUG=1`, unhandled `response.*` event types are logged once as `[openai.stream.unhandled]` so accumulator coverage gaps can be discovered from live traffic without flooding logs; keep the noisier per-event stream summaries behind `CODELIA_PROVIDER_LOG=1`.

- Explicit Ultrafast uses `serviceTier: "ultrafast"` for public API requests.
  The installed SDK union lags this value; keep its compatibility cast at the
  request's `service_tier` assignment. Runtime owns model/auth admission; do not
  change OAuth endpoints or silently downgrade when the tier is rejected.
