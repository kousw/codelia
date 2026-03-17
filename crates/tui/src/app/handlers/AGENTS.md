# handlers layer

`src/app/handlers/` owns key-driven application behavior.

## Scope

- `command.rs`: thin command-entry router and stable external API for submit/queue dispatch helpers.
- `command/*`: focused command submodules (`slash`, `bang`, `prompt`, `queue`).
- `panels.rs`: panel interaction key handling.
- `confirm.rs`: confirm lifecycle and confirm-response input handling.
- `runtime_response/*`: runtime output/RPC response application and routing (Layer 2 behavior).

## Rules

- Handlers mutate `AppState` and trigger runtime calls through `runtime/*`.
- Keep parser/formatting/presentation concerns out of handlers.
- Shared suggestion/completion logic should stay in `state/ui/*` (not duplicated here).

## Dependency Direction

- Allowed: `handlers -> state/runtime/util`.
- Avoid `handlers -> view` dependency; use `app::theme` / `app::markdown` shared modules instead.
