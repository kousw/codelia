# event_loop/runtime module

`src/event_loop/runtime/` contains runtime-output handling submodules extracted from the former monolithic `event_loop/runtime.rs`.

## Scope
- `response_dispatch.rs`: parsed output application and RPC-response state transitions.
- `panel_builders.rs`: panel state construction/format rows for model/session/context views.
- `formatters.rs`: shared runtime-log formatting and RPC error formatting helpers.

## Dependency Direction
- `response_dispatch` may depend on `panel_builders` and `formatters`.
- `panel_builders` may depend on `formatters` for shared truncation helpers.
- Keep this layer independent from `view/*` internals.

## Notes
- Preserve behavior during extraction: prefer function moves over logic rewrites.
- Public API for outer module remains in `event_loop/runtime.rs` via re-exports.
