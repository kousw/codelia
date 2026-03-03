# entry module

`src/entry/` owns TUI startup composition concerns extracted from `main.rs`.

## Scope
- `cli.rs`: basic CLI option parsing/help/version label and env-backed debug toggles.
- `bootstrap.rs`: startup banner/app bootstrap and resume initialization requests.
- `terminal.rs`: terminal session setup/teardown (raw mode, keyboard flags, cursor restore).

## Dependency Direction
- `entry/*` may depend on `app/*`.
- `entry/*` must not depend on `view/*` internals directly outside public `app` APIs.
- Runtime protocol I/O should continue to go through `app::runtime` client helpers.

## Notes
- Keep `main.rs` focused on composition root + tick loop orchestration.
- If startup flow grows further, split `main` loop concerns separately from startup concerns.
