# Image generation rules

- Never fall back across mode, provider, model, endpoint, account, auth or billing.
  Metadata discovery is not paid account verification. Missing route credentials
  are errors; Codex OAuth does not require an API key.
- Never switch chat auth while resolving images or send OAuth to custom Image APIs.
  Builtin OAuth refresh goes through AuthResolver and preserves method/account.
  Check account identity after refresh, before sending to the fixed Codex origin.
   Image configuration accepts environment variable names, not literal keys,
   headers or arbitrary endpoint URLs. Explicit reference URLs use the separate
   source-reader policy, never the authenticated generation transport.
- Keep origins fixed and requests bounded/cancellable. Do not log raw bodies,
  credentials or provider errors. No automatic paid retries, including timeouts.
- Validate endpoint-specific options before OpenRouter generation; pin exactly
  one endpoint and disable provider fallbacks. Reject unsupported output rather
  than silently converting formats or switching models.
- Save validated immutable original bytes before reporting success; edit from
  originals and retain parent artifact identities. A filesystem path is not model
  vision input. Materialize references only at the model-request/preview boundary.
- Keep generation/export permission checks inside tool execution so direct RPC
  cannot bypass them. Do not skip normal permissions based on tool names alone.
- Local storage/auth is only composed for TUI-local environments. Other hosts
  must supply an explicit image capability before using host resources.
- Reference inputs are explicit and ordered. Reject unknown fields, unavailable
  sources, unsupported counts, MIME mismatches and byte limits before generation;
  never drop references or retry as text-only. Do not follow source redirects or
  forward provider credentials. Only socket-validated public IPs are eligible.
- Do not add fetched reference bytes, source timestamps or rewritten URLs to old
  history messages. Generated image history keeps immutable artifact refs; request
  materialization must not rotate older image parts into text as new images arrive.
  Stable prefixes are tested separately from provider-reported cache-hit metrics.
- Attached image provenance must not invent generation model/provider/cost. Preserve
  MIME and bytes, expose a stable ID, and require an explicit artifact reference for
  generation. Storage accepts GIF, but generation rejects it before a paid request;
  do not silently convert. Do not count base64 as text tokens or use file-byte totals
  as a context-compaction threshold.

- Model-view transformation is an admission-time choice: pin the persisted bytes
  in new refs, preserve original bytes for generation/export, and never rebuild
  or change prior model inputs to reduce current payload size.
