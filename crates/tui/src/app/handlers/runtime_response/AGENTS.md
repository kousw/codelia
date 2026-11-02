# runtime_response handlers

`src/app/handlers/runtime_response/` owns runtime-output to `AppState` transition logic (Layer 2 application behavior).

## Scope
- `mod.rs`: runtime line poll application and RPC response routing.
- `parsed_output.rs`: parsed runtime event application + UI request handling.
- `{session,model,lane,mcp,skills,context_inspect,run_control}.rs`: domain-specific RPC handlers.
- `panel_builders.rs`: panel row/state projections.
- `formatters.rs`: runtime log/error formatting helpers.

## Dependency Direction
- Allowed: `runtime_response -> app/state/runtime/handlers`.
- Keep this layer independent from `event_loop` module internals.
- Do not import `view::theme` directly; use `app::handlers::theme` facade.
- Keep RPC id match/clear in `AppState.rpc_pending` (`take_match_for_response`).

## Notes
- Preserve handler order when routing RPC responses.
- Prefer function moves/splits over behavior rewrites.
- Progress updates replace their tracked log row only while it remains mutable; once inline scrollback has committed it, append and track a new row instead. Native terminal history cannot be updated in place.
- The parser suppresses live `tui_show_progress` call and successful result transcript lines: the client request already renders the progress row. During history replay, pair call/result by run and tool-call ID and reconstruct the row only after success, without sending client-tool responses. Failed results remain visible.
