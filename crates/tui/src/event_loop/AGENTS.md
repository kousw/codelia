# event_loop module

`src/event_loop/` owns the TUI tick-loop behavior extracted from `main.rs`.

## Scope
- `update.rs`: TEA `Msg`, `UpdateResult`, and dispatch. Honor `skip_post_input_tick` for consumed preview keys, non-press events and the first Ctrl+C cancellation.
- `runtime.rs`: thin re-export boundary to app-layer runtime response handlers.
- `input.rs`: key/paste/mouse input handling and dialog/panel key routing.

## Dependency Direction
- `event_loop/input.rs` handles application input and depends on `app/*`. Return mouse capture, clipboard and update-control effects for `entry/run_loop.rs` to execute.
- `event_loop/runtime.rs` should remain a thin wiring boundary only.
- `event_loop/*` must not depend on view internals beyond public draw/render APIs already used by `main.rs`.
- Runtime response handling implementation lives under `app/handlers/runtime_response/*`.
- Theme application from runtime responses should go through `app::handlers::theme::apply_theme_from_name` (avoid direct `view::theme` imports).
- Prefer `app::handlers` facade functions from `event_loop/*` instead of directly importing `app::handlers::command`.
- Use `AppState.rpc_pending` for outgoing RPC registration and send rollback. Response handlers own matching and dispatch.

## Notes
- Keep `main.rs` as composition/orchestration root; move additional tick-loop branches here first.
- Keep RPC sends synchronous through `RuntimeTx`. The preview worker stays encapsulated in its feature module.
- Route terminal paste through `AppState::paste_target` with the startup gate.
  An uncovered prompt accepts text paste even during startup. Alt+V in that
  prompt shows the composer-only file and image paste notice.
- Route the full crossterm `MouseEvent` for owned transcript selection. Gate it
  on resolved alternate mode, mouse capture, a current hit map, and no modal
  owner; preserve wheel handling independently. Only an unmodified primary
  gesture is owned: ignore modified down events and cancel if modifiers appear
  during an active owned drag.
- A left-button release received while the frame is dirty must cancel an active
  drag and request redraw. Crossterm does not resend release events, so never
  leave the selection in `Dragging` while discarding that event.
- Preserve behavior during extraction refactors: prefer function moves over logic rewrites.
