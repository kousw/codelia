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

`config.ts` implements `config.get` / `config.set` over the allow-listed
registry in `../config-keys.ts` (runtime-owned config only). Add a key only if
its layers merge as "last wins" and it cannot run commands or redirect
endpoints/credentials; keys with a validated setter stay read-only with
`writeVia`. Project config resolves from the agent's workspace root, not the UI
cwd. Writes are idle-only and invalidate the cached agent.

`permissions.ts` implements `permissions.list` / `permissions.remove` over the
config-file `permissions.allow/deny` lists (runtime-owned config only). Listing
resolves the approval mode without startup selection (never prompts/persists).
Removal is structural (all rule fields), idle-only, and invalidates the cached
agent; it never edits `projects.json`.

`context-usage.ts` serves `context.usage` from the cached agent only (never
builds one) and emits opt-in `run.context.usage` once per new provider usage
object or compaction. Emission is best-effort and never fails a run.

`task.ts` adds in-memory `progress` to subagent `TaskSummary` results and
streams opt-in `task.progress` (state changes immediately, progress coalesced
to 250 ms per task, trailing timer unref'd).

Idle-only management writes (`config.set`, `permissions.remove`, API-key
`auth.login`) recheck `activeRunId` and write inside
`RuntimeState.withAdmissionLock()`, which `run.start` admission also holds until
`beginRun`; a write and a run admission can never interleave. Credential
changes go through `AuthStore.update()` / `clearAll()` (per-file queue). An
OAuth/device-code login is claimed (`settled`) before its credential is saved,
so a later cancel reports `cancelled: false` instead of racing the write.

`run-metrics.ts` derives observed TPS from optional persisted completion timing
and provider usage. `run.ts` emits normal-mode `run.metrics` for every completed
LLM call; call starts do not emit metric resets. Reject
sub-250ms intervals and known hidden-reasoning usage without a matching observed
reasoning interval (`reasoning_item` for Responses or `thought_step` for Google).
Null means this call has no usable measurement; TUI retains the last known rate.
Diagnostics reuse the
same calculation. Metrics failures are best-effort and must not fail the run.


Failed runs forward `normalizeRunFailure().statusError` in optional `run.status.error`, independently of diagnostics mode. Retain the same safe detail/hint in `run.error`; the wire path must use the stack-free status object, not the storage error object.
