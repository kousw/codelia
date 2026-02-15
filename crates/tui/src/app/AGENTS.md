# app module

`src/app/` is the application root for TUI runtime loop integration.

## Scope

- Own `AppState` and cross-layer orchestration helpers (`mod.rs`).
- Assemble sub-layers:
  - `state/`: persistent UI/render/domain state
  - `view/`: frame composition
  - `render/`: terminal side effects
  - `handlers/`: key-driven behavior
  - `runtime/`: RPC boundary
  - `util/`: shared helpers

## Dependency Direction

- Prefer one-way flow:
  - `handlers/view/render/runtime -> state`
- `view` must not depend on `handlers`.
- Terminal side effects belong in `render`, not `view`.

## References

- `crates/tui/AGENTS.md`
- `docs/specs/tui-architecture.md`
- `docs/specs/tui-render-state-machine.md`

