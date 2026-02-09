# Codelia

Codelia is a TypeScript-based agent SDK with a runtime (`@codelia/runtime`) and a Rust TUI (`crates/tui`).

## Current Status

- Implemented: core/runtime/protocol/storage packages and Rust TUI integration.
- Implemented: `@codelia/cli` launches TUI by default and provides `codelia mcp ...` subcommands.
- Partial: sandboxing is path-based in app/runtime logic; OS-level hard isolation is not complete yet.

## Packages

- `packages/core`: Agent loop, tools, model/provider integration.
- `packages/runtime`: JSON-RPC runtime server and tool execution.
- `packages/protocol`: Runtime/UI protocol contracts.
- `packages/storage`: Local storage paths and persistence.
- `packages/cli`: CLI entrypoint (`codelia`).
- `crates/tui`: Rust TUI client.

## Requirements

- Bun
- Rust toolchain (`cargo`) for local TUI build/run

## Setup

```sh
bun install
```

### Provider auth setup (TUI first run)

Current runtime provider support is `openai` and `anthropic`.

- Option A (env): set `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` before launch.
- Option B (interactive): launch TUI and enter credentials in prompts.
  - OpenAI: choose OAuth (ChatGPT Plus/Pro) or API key.
  - Anthropic: API key prompt.

Entered credentials are stored in local auth storage (`~/.codelia/auth.json` by default).

### Run TUI directly in development (no link needed)

```sh
bun run tui
```

`bun run tui` uses `cargo run`, so `bun link` is not required for this path.

### Build workspace packages

```sh
bun run build
```

### Use `codelia` command from shell (first-time setup)

`bun run build` only builds artifacts.  
If you want to run `codelia` directly from your shell, you need one-time linking:

```sh
bun run build:link
```

Equivalent manual flow:

```sh
bun run build
cd packages/cli && bun link
```

After linking, you can launch from your shell with:

```sh
codelia
```

## Known Issues

- Permissions are policy-based (`allow/deny/confirm`) in runtime and are not a full OS-level security boundary.
- Sandbox checks protect file tools via path resolution, but `bash` runs on the host shell with sandbox `cwd`; this is not complete isolation.
- Worker isolation hardening (for example `bwrap`/`nsjail`/container-based execution) is still planned/in progress.

## Development

- Typecheck: `bun run typecheck`
- Tests: `bun run test`
- Format: `bun run fmt`
- Dependency hygiene: `bun run check:deps`
- Workspace version sync check: `bun run check:versions`

## Docs

- Architecture: `docs/typescript-architecture-spec.md`
- Specs / SDD: `docs/specs/` (may include planned or partially implemented items, and may lag behind current implementation)
