# Runtime RPC handlers

The request boundary validates envelopes and object-shaped params, catches
asynchronous handler failures, and emits at most one response in the request's
async context. Unexpected errors return a generic internal error only if no
response was sent. A failed pre-response `run.start` setup must release its
admitted run; do not automatically replay an uncertain request.

`model.set` and session reset share speed/auth admission. Validate the persistent
reset target before clearing the live override, saving session metadata, or
discarding the current agent; a rejected reset must preserve all three.
When changing to Google or DeepSeek, normalize an inherited boolean Fast setting to `false`
before saving either scope; reject an explicit Fast request without writes.

`auth.ts` handles confirmed local logout and host-owned credential removal.
Named logout deletes only the requested saved provider and resets only a matching
current session. Host adapters must opt into `clearProviderAuth`; scoped requests
must never call all-provider `clearAuth` as a fallback. Keep the advertised
`supports_scoped_logout` capability aligned with this support.

`auth-management.ts` implements `auth.status` / `auth.login` /
`auth.login.complete` / `auth.login.cancel` behind `supports_auth_management`
(runtime-owned auth only). Status never returns key/token material. Logins are
explicit user RPCs (no `ui.confirm`), saved with reload-then-merge, and
invalidate the cached agent through `RuntimeState.requestAgentInvalidation()`
(deferred to `finishRun` if a run started while an OAuth flow was pending).
One OAuth/device-code login may be pending; its outcome is one
`auth.login.status` notification. `auth.logout { confirmed: true }` skips the
runtime confirm for clients that confirmed themselves.

`run-metrics.ts` derives observed TPS from optional persisted completion timing
and provider usage. `run.ts` emits normal-mode `run.metrics` for every completed
LLM call and null at each call start to clear the previous call's value. Reject
sub-250ms intervals and known hidden-reasoning usage without a matching observed
reasoning interval. Diagnostics reuse the
same calculation. Metrics failures are best-effort and must not fail the run.
