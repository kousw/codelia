# Runtime parser

`parser.rs` owns wire decoding. Parser-level regressions live in `parser/tests.rs`. Keep event ordering and `ParsedOutput` behavior stable while refactoring rendering internals.
Every runtime -> UI method is catalogued: `typed_output` decodes it with the
generated types in `crate::protocol` and hands typed values to presentation:
`events.rs` (`agent.event`, `run.status`, `run.metrics`, client tools) and
`notifications.rs` (dialogs, `run.context`, `run.diagnostics`, goals).
Opt-in notifications the TUI does not request decode to empty output. A
replayed `agent.event` that fails strict decoding becomes one status line naming
its event type (`events::unreadable_history_event_output`). Parser tests complete omitted protocol fields
through `test_support`; call `super::parse_runtime_output` directly to test
strict decoding.
`run.metrics` returns typed status metadata without transcript lines; null or
invalid TPS becomes unavailable metadata. The handler matches active run identity
and retains last-known status values when no replacement measurement is available.
`agent.event` replay uses `meta.replayed`; while history is pending, unmarked
events from older runtimes are treated as replay unless they belong to the
active run. Replayed progress call/result pairs are rendered by the handler,
never as new client-tool requests.

`done` calls and successful results produce no transcript rows or pending-call
tracking, both live and on replay. Its authoritative `final` event renders the
completion message once as normal assistant Markdown. Failed results must remain
visible through the usual error/fallback-summary path even without a call row.

## Dependency direction

- `types.rs` owns parser output DTOs.
- `common.rs` owns small pure presentation primitives shared by multiple renderers.
- `helpers.rs` owns general protocol formatting and the single tool-result dispatcher.
- `diff.rs` owns unified-diff parsing, syntax-highlighted diff rendering, permission previews, and normalized diff fingerprints.
- `web.rs` owns `web_search` / `webfetch` call and result summaries.
- Domain renderers such as `todo.rs`, `lane.rs`, `agents.rs`, and `shell.rs` may depend on `common.rs` and `app::state` presentation types.
- `subagents.rs` formats task_* calls/results using agent name, child state, assignment and bounded summary/failure detail. Do not dump lineage/permission JSON. A successful task_wait transport still shows failure when the child state is failed; keep pending-header replacement consistent with that state.
- Message send/receive and the exact runtime `hidden_user_message` peer envelope
  show authenticated display names and bounded content, not raw message JSON or
  a user-input prefix. Sent means stored, not read; incoming messages remain
  coordination only. Other hidden-user content keeps its existing fallback.
- Domain renderers must not depend on `handlers`, `view`, `render`, `AppState`, or runtime process/RPC adapters.
- Keep terminal side effects and application-state mutation outside parser modules; renderers return `LogLine` values and metadata only.
- `llm.status` renders fixed verification/buffering messages as status lines;
  ignore clear/unknown states and do not populate assistant_text or print raw
  provider fields. Suggested models do not trigger selection or retry.

Prefer a domain module when a renderer has its own parsing, error classification, summary, and detail rules. Do not create a broad service locator or pass the whole `AppState` to renderers.

Keep the shell domain cohesive: tool-call summaries, tagged shell blocks, JSON task records, error classification, metadata, and bounded output previews belong in `shell.rs`. The general dispatcher should only select the renderer and preserve fallback behavior.

`errors.rs` projects optional structured run errors into summary/safe details/next step, ignoring raw fields and stacks. The handler routes them through `push_error_report` so `/errors show` works without routine diagnostics. Legacy unstructured statuses keep their fallback path.
