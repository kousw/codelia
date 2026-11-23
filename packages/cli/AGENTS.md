# @codelia/cli

CLI package. The binary name is `codelia` and the entry is `src/index.ts`.
`codelia session list/pin/unpin/archive/unarchive/cleanup` manages local run-log
maintenance. Archive/unpin retain gzip event history while removing diagnostics,
including embedded snapshots in legacy plain/gzip logs. Explicit dumps may expire.
Originals, active checkpoints and reference data remain. ATIF reads plain/gzip logs.
ATIF remains opt-in through `CODELIA_ATIF_OUT` and accepts compact `llm.usage`
records with per-sequence legacy response fallback, without requiring full dumps.
Acts as a launcher that launches Rust TUI by default.
`src/index.ts` is a thin dispatcher, MCP command is split into `src/commands/mcp.ts`, and TUI startup is split into `src/tui/launcher.ts`.
`src/commands/mcp.ts` is only for routing, and the actual processing is divided into `src/commands/mcp-config.ts` and `src/commands/mcp-auth.ts`.
Argument processing uses `src/args.ts` (based on `cac`).
MCP-related shared processing has been divided into `src/mcp/` (`protocol.ts` / `probe.ts` / `auth-file.ts`).
MCP protocol version judgment logic uses `mcp-protocol` helper of `@codelia/protocol`.
MCP auth saving/loading uses `McpAuthStore` of `@codelia/storage` and has a common implementation with runtime.
Server config normalization of `src/commands/mcp-config.ts` uses the `zod` schema.
`src/commands/mcp-config.ts` config update (add/remove/enable/disable) uses `@codelia/config-loader` update API (does not have raw JSON update logic); when project `.codelia/config.json` resolves to the same file as global `config.json`, `project`-scoped updates are rejected with instructions to pass `--scope global`, and `list` deduplicates layers while preserving untrusted `project` provenance for checkout-local `CODELIA_CONFIG_PATH`.
`src/args.ts` is a thin wrapper that directly holds `options` of `cac` and does not have its own Map/Set transformation.
- Top-level basic options are handled in `src/basic-options.ts` (`--help` / `--version`) before command dispatch; TUI flags like `--debug` and `--tui-mode` are passed through.
- `src/update/` and `src/commands/update.ts` implement simplified self-update (`codelia update [--check]`, `update.mode` (`notify` default | `auto` opt-in | `off`) and `update.channel` in global `config.json`, `CODELIA_AUTO_UPDATE`, `CODELIA_UPDATE_CHANNEL`). Interactive TUI launches check npm dist-tags in the background (2h success / 5 min failure TTL; scope changes clear stale candidates on failure), pass bounded startup notices to Rust TUI through the launch context (`update_notice_file`), and (on explicit `codelia update` or opt-in `auto`) verify `npm prefix -g` without `--prefix` and apply updates in-place via `npm install -g --prefix <prefix> @codelia/cli@<version>` under `<node_modules>/.codelia-update.lock.sqlite` before re-exec (`CODELIA_UPDATE_REEXEC`). Non-npm installs (Homebrew Cellar, Nix, pnpm, Bun, Yarn, Volta, mise, npx, local, source checkout) surface manual command hints instead of auto-applying.
CLI version is injected at build time (`__CODELIA_CLI_VERSION__` via `tsup`) and passed to TUI in the `--internal-launch-context=<json>` argument (`buildTuiLaunchContext` / `buildTuiArgs` in `src/tui/launcher.ts`). The launcher drops user-forwarded copies of that flag. Launcher-owned values (CLI version, bundled runtime command, notice file, update control entry, startup confirmations) never travel through the environment; prompt mode spawns the runtime with the inherited environment unchanged.
You can edit/check `mcp.servers` of `config.json` with the `codelia mcp` subcommand (`add/list/remove/enable/disable/test`).
The `mcp-auth.json` token can be managed with the `codelia mcp auth` subcommand (`list/set/clear`).
TUI startup can be overridden with `CODELIA_TUI_CMD` / `CODELIA_TUI_ARGS`.
Prompt mode (`-p/--prompt`) forwards runtime `stderr` to the caller process `stderr` while keeping protocol traffic on `stdout`.
The managed Harbor client can answer once-only shell approvals when its launcher passes `--harbor-shell-approval`, sets `CODELIA_HARBOR_SHELL_APPROVAL=1`, and explicitly selects `--sandbox-mode full-access`. Runtime initialization must confirm the mode and structured approvals. An environment marker alone cannot authorize replies. The prompt client matches the active run and the runtime's `Approve shell?` approval request. It declines other UI requests and never saves grants.
When `CODELIA_ATIF_OUT` is set, prompt mode writes Harbor ATIF from the runtime session jsonl on completed, error, and cancelled terminal statuses, and attempts a best-effort partial write on catchable termination signals (`SIGHUP`/`SIGINT`/`SIGTERM`). Keep ATIF output atomic by writing a temp file before renaming to the target path.
With an explicit `--sandbox-mode` flag, ATIF `extra` records `sandbox_mode_requested` from the CLI and `sandbox_mode` from the runtime's initialize response. A missing or unsupported report is `null`.
TUI `/update` uses the private CLI controls `update --tui-status` and `update --tui-set-mode` through the current launcher's absolute paths. The controls only read local update state or save global `update.mode`; they never fetch or install.

The launcher passes only built-in startup confirmation IDs selected for this launch, in the launch context. Update preparation adds `update-mode` only for an absent global mode on eligible interactive launches; do not treat an invalid config or explicit mode as unset. The chosen mode does not alter the prepared launch policy.

For TUI startup resolution, prefer local development binaries (`crates/tui/target/*`) first, then fall back to `@codelia/tui-*` of `optionalDependencies`, and finally PATH fallback.
No binary copy is performed with `postinstall` (it directly resolves `bin/` of the platform package at runtime).
`package.json` includes `overrides.gaxios = 7.1.4` to avoid the `gaxios@7.1.3 -> rimraf -> glob` deprecated warning path during npm installation.
The default root of the sandbox is the current directory at startup. You can override the route by specifying `CODELIA_SANDBOX_ROOT` (does not create an initial file).
By design, do not call `@codelia/core` directly from the product path (no tool implementation/agent construction).
The CLI typecheck follows `@codelia/runtime/sdk` into workspace sources. Keep transitive source aliases in `tsconfig.json` resolvable in CI, which only builds `@codelia/core` before typechecking.
The old `basic-cli` implementation has been moved to `examples/basic-cli/`.
Place the CLI test in `packages/cli/tests/` (bun test).

Execution example:
- `bun run --filter @codelia/cli build`
- Interactive mode (OpenAI): `OPENAI_API_KEY=... node packages/cli/dist/index.cjs`
- Interactive mode (Anthropic): `ANTHROPIC_API_KEY=... node packages/cli/dist/index.cjs`
- Sandbox fixed: `OPENAI_API_KEY=... CODELIA_SANDBOX_ROOT=./tmp/sandbox node packages/cli/dist/index.cjs`
