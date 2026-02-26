# @codelia/cli

CLI package. The binary name is `codelia` and the entry is `src/index.ts`.
Acts as a launcher that launches Rust TUI by default.
`src/index.ts` is a thin dispatcher, MCP command is split into `src/commands/mcp.ts`, and TUI startup is split into `src/tui/launcher.ts`.
`src/commands/mcp.ts` is only for routing, and the actual processing is divided into `src/commands/mcp-config.ts` and `src/commands/mcp-auth.ts`.
Argument processing uses `src/args.ts` (based on `cac`).
MCP-related shared processing has been divided into `src/mcp/` (`protocol.ts` / `probe.ts` / `auth-file.ts`).
MCP protocol version judgment logic uses `mcp-protocol` helper of `@codelia/protocol`.
MCP auth saving/loading uses `McpAuthStore` of `@codelia/storage` and has a common implementation with runtime.
Server config normalization of `src/commands/mcp-config.ts` uses the `zod` schema.
`src/commands/mcp-config.ts` config update (add/remove/enable/disable) uses `@codelia/config-loader` update API (does not have raw JSON update logic).
`src/args.ts` is a thin wrapper that directly holds `options` of `cac` and does not have its own Map/Set transformation.
Top-level basic options are handled in `src/basic-options.ts` (`--help` / `--version`) before command dispatch; TUI flags like `--debug` are passed through.
CLI version is injected at build time (`__CODELIA_CLI_VERSION__` via `tsup`) and passed to TUI as `CODELIA_CLI_VERSION`.
You can edit/check `mcp.servers` of `config.json` with the `codelia mcp` subcommand (`add/list/remove/enable/disable/test`).
The `mcp-auth.json` token can be managed with the `codelia mcp auth` subcommand (`list/set/clear`).
TUI startup can be overridden with `CODELIA_TUI_CMD` / `CODELIA_TUI_ARGS`.
Prompt mode (`-p/--prompt`) forwards runtime `stderr` to the caller process `stderr` while keeping protocol traffic on `stdout`.
For TUI startup resolution, prefer local development binaries (`crates/tui/target/*`) first, then fall back to `@codelia/tui-*` of `optionalDependencies`, and finally PATH fallback.
No binary copy is performed with `postinstall` (it directly resolves `bin/` of the platform package at runtime).
The default root of the sandbox is the current directory at startup. You can override the route by specifying `CODELIA_SANDBOX_ROOT` (does not create an initial file).
By design, do not call `@codelia/core` directly from the product path (no tool implementation/agent construction).
The old `basic-cli` implementation has been moved to `examples/basic-cli/`.
Place the CLI test in `packages/cli/tests/` (bun test).

Execution example:
- `bun run --filter @codelia/cli build`
- Interactive mode (OpenAI): `OPENAI_API_KEY=... node packages/cli/dist/index.cjs`
- Interactive mode (Anthropic): `ANTHROPIC_API_KEY=... node packages/cli/dist/index.cjs`
- Sandbox fixed: `OPENAI_API_KEY=... CODELIA_SANDBOX_ROOT=./tmp/sandbox node packages/cli/dist/index.cjs`
