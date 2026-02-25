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
- Reuse of an OPEN websocket is also bounded by a short idle window; after idle expiry, reconnect with a fresh websocket before sending the next request.
- In `websocket_mode=on`, timeout/closed-response websocket errors are retried once with a fresh websocket (WS-only retry; no HTTP fallback).
