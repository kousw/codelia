# event_loop module

`src/event_loop/` owns the TUI tick-loop behavior extracted from `main.rs`.

## Scope
- `runtime.rs`: module entry + re-exports for runtime handling submodules.
- `runtime/response_dispatch.rs`: parsed runtime output application + RPC response handlers.
- `runtime/panel_builders.rs`: panel row/state builders shared by response handlers.
- `runtime/formatters.rs`: formatting helpers for runtime/status/error output.
- `input.rs`: key/paste/mouse input handling and dialog/panel key routing.
- `mod.rs`: shared loop-local aliases (`RuntimeStdin`, `RuntimeReceiver`).

## Dependency Direction
- `event_loop/*` may depend on `app/*` and `entry/terminal` adapter types.
- `event_loop/*` must not depend on view internals beyond public draw/render APIs already used by `main.rs`.

## Notes
- Keep `main.rs` as composition/orchestration root; move additional tick-loop branches here first.
- Prefer pure helpers for formatting/parsing when possible; isolate side effects to runtime send calls and `AppState` mutation.
