# Stream timing rules

- Timing is optional telemetry. Never estimate usage from characters/chunks or
  use lifecycle/empty events as first output. A Responses reasoning-item start
  may separately mark observed generation activity; retain first-delta timing
  and record the marker's source explicitly. Preserve missing timing for
  nonstreaming/custom adapters rather than substituting total request latency.
- Never reuse timing across retries, reconnects or fallback attempts. Use a
  monotonic clock; keep request/response wall timestamps separate.

# Endpoint contracts

- Keep Codex backend extension handling scoped to that fixed endpoint. Public
  Responses API clients continue using the official SDK stream helper. SDK HTTP,
  SSE decoding, bearer auth and cancellation remain the transport substrate.
- Unknown metadata never establishes completion. Failed or truncated streams
  must not return partial success; cancellation remains distinguishable from EOF.
- Codex turn routing belongs to a user run, not a durable session. Capture the
  first server token, replay unchanged only for that run/auth owner, redact it,
  and never expose it in model-visible or persisted metadata.
- Provider statuses are informational display events. Their callbacks cannot
  fail requests, and queue teardown cancels pending inference. No metadata-driven
  automatic replay, verification, auth change or model switch.

## Live output previews

- Only normalized text/reasoning deltas may enter previews. Keep canonical responses authoritative, isolate attempts across fallback/retry, preserve all received deltas while coalescing pending output, and never persist partial output as conversation history.

## Error-only context

- Keep diagnostic causes explicit and safe: typed local response reasons or allowlisted transport codes only. Raw exception messages, provider bodies, headers and stacks must not become provider error details or `run.status.error`.
