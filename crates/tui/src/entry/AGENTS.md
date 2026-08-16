# entry module

`src/entry/` owns TUI startup composition concerns extracted from `main.rs`.

## Scope
- `cli.rs`: basic CLI option parsing/help/version label, terminal-mode selection, and env-backed debug toggles.
- `bootstrap.rs`: startup banner/app bootstrap and resume initialization requests.
- `run_loop.rs`: interactive tick loop orchestration (runtime polling, input dispatch, redraw cycle).
- `terminal.rs`: terminal session setup/teardown (raw mode, keyboard flags, cursor restore). Do not issue OSC color queries during startup; delayed responses can leak into composer input on terminal bridges.
- `terminal_mode.rs`: pure `auto | inline | alternate` mode model and environment resolver. Keep environment capture separate from pure resolution so Windows/WSL policy remains unit-testable without mutating process-global environment.

## Dependency Direction
- `entry/*` may depend on `app/*`.
- `entry/*` must not depend on `view/*` internals directly outside public `app` APIs.
- Runtime protocol I/O should continue to go through `app::runtime` client helpers.

## Notes
- Keep `main.rs` focused on composition root and process lifecycle.
- Keep interactive loop behavior in `run_loop.rs`; split further there before growing `main.rs`.
- Pass `ResolvedTerminalMode` across terminal/run-loop boundaries; do not reintroduce a shared `use_alt_screen: bool` policy flag.
