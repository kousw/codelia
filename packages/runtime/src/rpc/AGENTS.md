# Runtime RPC boundaries

RPC handlers compose existing runtime capabilities; keep model, permission and task policy in their owning modules. `ui-requests.ts` serializes root/child confirmations and scopes abort to the operation signal. Optional UI cancellation is negotiated, sent only for an already emitted request and keyed by exact request ID. `client-tool-requests.ts` has its separate timeout cancellation contract. See `dev-docs/specs/ui-protocol.md` and package-level AGENTS.md.

`run.ts` negotiates model text streaming, awaits transient transport delivery with caller cancellation and skips persistence/snapshots for stream events. `sendAgentEventAsync` can release its waiter on an optional AbortSignal; already queued host delivery may arrive late, so run ownership/sequence checks remain mandatory.

Explicit `new_session` creates a fresh thread; omission retains legacy current-session continuation. Validate workspace guard and saved session checkout before Agent creation. Different resumed model overrides invalidate the Agent cache. Initialize event storage before changing history/session or beginning the run; preflight errors must retain the previous state without model work. `model.set.expected_session_id` is compare-and-set, never navigation.

run.start.model is optional and validates before admission, applies only after exact target-thread selection, persists existing session override and rolls back preflight failure. model.list catalog_only requires provider and bypasses config/auth/network; never silently repair an invalid provider by writing configuration.
