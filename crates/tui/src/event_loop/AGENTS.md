# event_loop module

`src/event_loop/` owns the TUI tick-loop behavior extracted from `main.rs`.

## Scope
- `runtime.rs`: module entry + re-exports for runtime handling submodules.
- `runtime/response_dispatch.rs`: parsed output application and RPC-response state transitions.
- `runtime/panel_builders.rs`: panel state construction/format rows for model/session/context views.
- `runtime/formatters.rs`: shared runtime-log formatting and RPC error formatting helpers.
- `input.rs`: key/paste/mouse input handling and dialog/panel key routing.
- `mod.rs`: shared loop-local aliases (`RuntimeStdin`, `RuntimeReceiver`).

## Dependency Direction
- `event_loop/*` may depend on `app/*` and `entry/terminal` adapter types.
- `event_loop/*` must not depend on view internals beyond public draw/render APIs already used by `main.rs`.
- `runtime/response_dispatch.rs` may depend on `runtime/panel_builders.rs` and `runtime/formatters.rs`.
- `runtime/panel_builders.rs` may depend on `runtime/formatters.rs`.

## Notes
- Keep `main.rs` as composition/orchestration root; move additional tick-loop branches here first.
- Prefer pure helpers for formatting/parsing when possible; isolate side effects to runtime send calls and `AppState` mutation.
- Preserve behavior during extraction refactors: prefer function moves over logic rewrites.
