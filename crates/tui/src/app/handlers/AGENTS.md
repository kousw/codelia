# handlers layer

`src/app/handlers/` owns key-driven application behavior.

## Scope

- `command.rs`: slash command execution and composer submit flow.
- `panels.rs`: panel interaction key handling.
- `confirm.rs`: confirm lifecycle and confirm-response input handling.

## Rules

- Handlers mutate `AppState` and trigger runtime calls through `runtime/*`.
- Keep parser/formatting/presentation concerns out of handlers.
- Shared suggestion/completion logic should stay in `state/ui/*` (not duplicated here).

## Dependency Direction

- Allowed: `handlers -> state/runtime/util`.
- Avoid `handlers -> view` dependency.

