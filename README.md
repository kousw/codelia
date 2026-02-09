# Codelia

Codelia is a TypeScript agent SDK with a runtime and a Rust TUI for interactive use.

## Overview

- Core agent loop, tools, and context management in TypeScript.
- Runtime JSON-RPC server to connect UI/TUI to core.
- Rust TUI for interactive sessions.
- Storage layer for session logs and resume state.

## Packages

- `packages/core`: Agent loop, tool system, context management, and providers.
- `packages/runtime`: JSON-RPC runtime server and tool integration.
- `packages/protocol`: UI/runtime protocol types.
- `packages/storage`: Session and state persistence.
- `packages/cli`: CLI entrypoint (work-in-progress).
- `crates/tui`: Rust TUI client.

## Requirements

- Bun (workspace tooling)
- Rust toolchain (for TUI)

## Quick start

```sh
bun install
```

Set your API key (e.g. `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`) and run the TUI:

```sh
bun run tui
```

## Development

- Typecheck: `bun run typecheck`
- Tests: `bun run test`
- Format: `bun run fmt`

Specs and architecture notes live under `docs/specs/` and `docs/typescript-architecture-spec.md`.

## Acknowledgements

Inspired by browser-use/agent-sdk (MIT). Thanks!
