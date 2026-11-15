# Stream timing rules

- Timing is optional telemetry. Never estimate usage from characters/chunks or
  use lifecycle/empty events as first output. A Responses reasoning-item start
  may separately mark observed generation activity; retain first-delta timing
  and record the marker's source explicitly. Preserve missing timing for
  nonstreaming/custom adapters rather than substituting total request latency.
- Never reuse timing across retries, reconnects or fallback attempts. Use a
  monotonic clock; keep request/response wall timestamps separate.
- Create the tracker before starting/awaiting the transport request. Map
  provider-specific observed reasoning activity (Responses reasoning item or
  Google thought step) separately from first nonempty output; lifecycle and
  signature events must not invent first-output timing.
- Provider additions and transport migrations require fixture verification of
  normalized usage and completion timing through runtime `buildRunMetrics`,
  including reasoning-bearing and tool-only turns. A timing object alone is
  insufficient: assert usable TPS when the interval is observable and null when
  usage/activity is unavailable. Check cancellation/truncation and attempt
  isolation in the owning adapter tests. Extend the shared metrics matrix or
  provider-specific metrics fixtures; document any intentional limitation.
  The shared matrix is exhaustive over builtin provider names (Google has
  dedicated fixtures); a new builtin must add a fixture to pass typecheck.

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
