# RPC authentication rules

- Validate logout names before mutation; preserve unrelated credential entries and sessions.
- Reload saved auth after UI confirmation; never log credentials or raw auth-file errors.
- Do not reinterpret unsupported scoped requests as all-provider logout.

## LLM metrics

- Derive TPS only from finite non-negative provider output usage and a positive
  monotonic generation interval. Missing/invalid data is null, never request
  latency or a token estimate. Do not persist a new metrics record type.
