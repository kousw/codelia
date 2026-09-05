# Subagent implementation rules

- Fail closed on unsupported context/workspace modes, tools, or host factories.
- Child bootstrap uses an inherited pipe, never argv/environment credentials.
- Keep concurrency configuration independent of model profiles. Validate host-supplied limits as well as parsed files, and never release capacity before executor cleanup.
- Keep execution deadlines opt-in throughout admission, bootstrap and process execution. Never substitute an execution timer for the bounded parent wait or treat lifetime history as an admission quota.
- Use canonical shared types for lineage and terminal reasons.
- Redact structured records through `redactSubagentJson` string values before
  JSON encoding. Never redact serialized JSON text then parse it: matching a
  Bearer value can consume the escape before a quote and corrupt valid records.
- Model session keys must identify the child, never its parent. Redact persisted
  model records and failure text; use normalized provider-safe messages and bound
  parent-visible causes to 2048 UTF-8 bytes without forwarding raw stacks/headers.
- Tests must cover admission/cancellation races and real process owner loss
  without depending on paid model calls.

- Bound both persisted messages and IPC frames in UTF-8 bytes. Reject overflow.
- Preserve runtime-supplied message identity; never accept a sender from tool args.
- Hash mismatch requires reread/coordination; no automatic overwrite or rollback.
- Execute structured child writes through the parent; serialize checking and
  updating together. Never hold that queue while waiting for UI approval.
- Shell is a broad capability outside per-file hash guards. Apply the immutable
  parent policy and keep its process group owned until cleanup finishes.

- Let the spawning parent choose varied agent names without a fixed roster.
  Use task descriptions for labels and UUIDs for
  identity. Do not recycle names within an owner session or route by display name.

- Keep model selection local and deterministic: explicit selection, configured default, then parent inheritance. Profile/model arguments are exclusive; no availability probes or silent model fallback.
