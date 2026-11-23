# Runtime RPC handlers

The request boundary validates envelopes and object-shaped params, catches
asynchronous handler failures, and emits at most one response in the request's
async context. Catalogued requests (`protocol.ts`, `@codelia/protocol`
`protocolMethods`) validate params with `parseRequestParams` after their
existing gates and answer `INVALID_PARAMS` with bounded `data.issues` that never
echo values; reply with `sendRequestResult`. Build catalogued notifications and
runtime -> UI requests with `notificationMessage` / `requestMessage`, and check
UI results with `parseUiResult` (a dialog reply that breaks the contract is a
declined dialog). Every method is catalogued; parse inside the handler when its
gates live there. The strict `task.spawn` and `permissions.remove` catalog
branches reject unknown keys at parse time. When a stripping schema has a
local unknown-key check, pass it the original params. Preserve v0 reasoning
normalization before the `model.set` parse. `ui.context.update` uses
`parseUiNotificationParams`. Outgoing payloads are sent unchanged and
asserted only when `CODELIA_PROTOCOL_ASSERT=1` (set by the root test preload). Unexpected errors return a generic internal error only if no
response was sent. A failed pre-response `run.start` setup must release its
admitted run; do not automatically replay an uncertain request.

`run.start` accepts client and goal tools only after approval registration.
Missing registration fails admission and releases any goal reservation.
`tool.call` keeps an in-flight receipt for the operator RPC. Shell/task starts
keep a distinct admission receipt at the dispatcher before spawning.
Receipts use the owner and initialized connection scope. Completed payloads
are released, and ID hashes prevent replay within that connection.

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
(runtime-owned auth only). Status reads existing credential slots in place, including legacy files. It never acquires the auth lock or initiates migration. Only method and expiry are projected into its provider summary. Logins are
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
changes go through `AuthStore.updateV2()` / `clearAll()` (interprocess SQLite lock).
`auth.status` returns non-secret `storage` (`configured`, `active`, `state`,
`fallback_reason?`) and `warnings` (`inline_mcp_config_secrets`,
`mcp_reauth_required`, `storage_conflict`, and distinct Keychain access errors) even when a storage conflict prevents
reading stored auth. `auth.storage.resolve_conflict` (`keep_keyring`, `keep_file`,
`keep_legacy`, `clear_all`) is idle-only, confirmation-gated, runs under the
interprocess lock, revokes local auto-review auth, and invalidates the cached agent.
An OAuth/device-code login is claimed (`settled`) before its credential is saved,
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

`run.steer` admission is serialized separately from run admission, rechecks the active run after image preparation, and closes before terminal teardown. Drained steers remain unconfirmed until `steer_applied` is emitted; report them in `unconsumed_steer_ids` if application fails or is cancelled. Polling alone is not consumption. The run-scoped client Steer ID index survives polling and application so retries replay the original acknowledgement. Live application and terminal fallback echo client IDs when available.

Session goal control lives in `goals.ts` and uses the run admission queue.
`goal.pause` latches matching stop intent before serialization. Keep goal
reservations and usage accounting durable, and emit a new offer only after
the checkpoint succeeds and `finishRun` releases the run.
Keep reporting guidance in `GoalController.tools()`. The transient run context
in `run.ts` carries the objective and newer-user-instruction priority. See the
[goal tool spec](../../../../dev-docs/specs/goals.md#model-facing-tools).

The capability-gated `auto_review.configure` is a TUI-local operator RPC independent of chat and auth settings. Picker writes require idle admission and recheck the private config version. Status and disabling are allowed during runs.

- `sandbox.get` reports the effective mode for the next run, applied agent/run mode, available choices and project editability. `sandbox.set` is an idle-only operator action scoped to the runtime’s own workspace. Respect CLI, environment and SDK ownership. See the [UI protocol](../../../../dev-docs/specs/ui-protocol.md#workspace-sandbox-rpc).

`initialize.local_host` contains Auto approve startup status for the
`tui-local` environment. Mirror the same status into `initialize.tui` for
older clients and keep the theme in `tui`.
