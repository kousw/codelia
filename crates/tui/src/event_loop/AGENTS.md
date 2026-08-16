# event_loop module

`src/event_loop/` owns the TUI tick-loop behavior extracted from `main.rs`.

## Scope
- `runtime.rs`: thin re-export boundary to app-layer runtime response handlers.
- `input.rs`: key/paste/mouse input handling and dialog/panel key routing.
- `mod.rs`: shared loop-local aliases (`RuntimeStdin`, `RuntimeReceiver`).

## Dependency Direction
- `event_loop/input.rs` is currently treated as Layer 2 application logic and may depend on `app/*`.
- `event_loop/runtime.rs` should remain a thin wiring boundary only.
- `event_loop/*` must not depend on view internals beyond public draw/render APIs already used by `main.rs`.
- Runtime response handling implementation lives under `app/handlers/runtime_response/*`.
- Theme application from runtime responses should go through `app::handlers::theme::apply_theme_from_name` (avoid direct `view::theme` imports).
- Prefer `app::handlers` facade functions from `event_loop/*` instead of directly importing `app::handlers::command`.
- RPC id matching/clearing should be delegated to `AppState.rpc_pending` (`take_match_for_response`) to keep dispatch logic thin.

## Notes
- Keep `main.rs` as composition/orchestration root; move additional tick-loop branches here first.
- Prefer pure helpers for formatting/parsing when possible; isolate side effects to runtime send calls and `AppState` mutation.
- Route the full crossterm `MouseEvent` for owned transcript selection. Gate it
  on resolved alternate mode, mouse capture, a current hit map, and no modal
  owner; preserve wheel handling independently. Only an unmodified primary
  gesture is owned: ignore modified down events and cancel if modifiers appear
  during an active owned drag.
- A left-button release received while the frame is dirty must cancel an active
  drag and request redraw. Crossterm does not resend release events, so never
  leave the selection in `Dragging` while discarding that event.
- Preserve behavior during extraction refactors: prefer function moves over logic rewrites.
