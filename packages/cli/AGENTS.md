# @codelia/cli

Product CLI entrypoint (`codelia`, `src/index.ts`). Never implement tools/agent construction or import `@codelia/core` directly from product paths.

## Entrypoints, Launcher & Self-Update

- `src/index.ts` dispatches `auth`, `mcp`, `session`, `update`, `-p/--prompt` (`src/prompt-mode.ts`), and TUI (`src/tui/launcher.ts`); `src/args.ts` wraps `cac` directly. CI typecheck follows `@codelia/runtime/sdk` into workspace sources while only `@codelia/core` is built — keep transitive `tsconfig.json` aliases resolvable.
- TUI binary resolution prefers `crates/tui/target/*` -> `@codelia/tui-*` `optionalDependencies` -> `PATH` (`CODELIA_TUI_CMD`/`_ARGS` override; `postinstall` copies nothing; `overrides.gaxios` prevents deprecated `rimraf`/`glob` npm warnings).
- Launcher passes launcher-owned metadata (`__CODELIA_CLI_VERSION__`, bundled runtime cmd, update notice/control paths, startup confirmation IDs) only via `--internal-launch-context=<json>` (drop user-supplied copies; never use env vars; prompt mode spawns runtime with inherited env unchanged). Prepare `update-mode` confirmation only when global `update.mode` is genuinely absent on eligible interactive launches.
- `src/update/` + `src/commands/update.ts`: global-only `update.mode` (`notify|auto|off`, env `CODELIA_AUTO_UPDATE`) and `update.channel`; background registry checks (`2h`/`5m` TTL), `<node_modules>/.codelia-update.lock.sqlite` lock, verify `npm prefix -g` before `npm install -g --prefix <prefix> @codelia/cli@<version>`, re-exec with `CODELIA_UPDATE_REEXEC`. Non-npm installs print manual hints. Private `--tui-status` / `--tui-set-mode` controls never fetch or install.

## Subcommands, Prompt Mode & ATIF

- `src/commands/mcp-config.ts`: uses `@codelia/config-loader` locked update APIs; rejects `project` updates when `.codelia/config.json` aliases global `config.json` while keeping `project` provenance for checkout-local `CODELIA_CONFIG_PATH`. `src/mcp/` shares `McpAuthStore` and `@codelia/protocol` `mcp-protocol` helpers with runtime.
- `src/commands/session.ts`: validates subcommands and IDs before opening stores; preserves resume snapshots, refs, tasks, and usage. Never trigger session cleanup from unrelated CLI commands or embedded hosts.
- Prompt mode forwards runtime `stderr` to `stderr` while keeping RPC on `stdout`. Managed Harbor `--harbor-shell-approval` requires both `CODELIA_HARBOR_SHELL_APPROVAL=1` and `--sandbox-mode full-access` confirmed at runtime `initialize` (matches active run `Approve shell?` only; declines other UI requests; never saves grants).
- `CODELIA_ATIF_OUT` (`src/atif.ts`) writes atomic temp+rename ATIF on terminal statuses and best-effort partial output on `SIGHUP`/`SIGINT`/`SIGTERM`, using compact `llm.usage` records (no full dumps required) and recording explicit `sandbox_mode_requested` vs `sandbox_mode`.
