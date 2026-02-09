# Codelia

Codelia is a coding agent SDK built with TypeScript, with a native Rust TUI as its primary interface.

Codelia's TypeScript runtime and Ratatui-based Rust TUI communicate over a JSON-RPC protocol. Because the runtime and UI are cleanly separated, other frontends (Desktop GUI, Web) can be built on top of the same Codelia runtime.

## Features

- **Inline TUI** — Runs without alternate screen, preserving your terminal scrollback. Markdown rendering with syntax highlighting.
- **Tool Output Cache & Compaction** — Tool outputs are stored outside the main context and referenced by pointer. When context usage reaches 80%, automatic summarization kicks in — so the agent stays coherent even on large codebases.
- **Skills** — Drop a `SKILL.md` in your repo or `~/.agents/skills/` and the agent can discover and load it. No plugin registration code needed.
- **MCP (Model Context Protocol)** — stdio and HTTP (SSE) transports, OAuth 2.1 + PKCE for remote servers. Manage with `codelia mcp add/list/test`.
- **Session Management** — SQLite-backed persistent sessions. Resume anytime with `/resume` or `--resume`.
- **Multi-Provider** — OpenAI and Anthropic. OpenAI also supports OAuth login for ChatGPT Plus/Pro subscriptions.

## Architecture

```
┌─────────────────┐   JSON-RPC / stdio   ┌─────────────────────────┐
│  Rust TUI       │ <──────────────────> │  TypeScript Runtime      │
│  (Ratatui)      │                       │                          │
│  Panels/Dialogs │                       │  Agent Loop  (core)      │
│  Session Picker │                       │  Tools & Permissions     │
│  Skills Browser │                       │  MCP Client              │
│  Context View   │                       │  Context Management      │
└─────────────────┘                       │  Provider Adapters       │
                                          │  Session Storage         │
                                          └─────────────────────────┘
```

## Packages

| Package | Role |
|---|---|
| `packages/core` | Agent loop, tools, model/provider integration |
| `packages/runtime` | JSON-RPC server, tool execution, permissions, MCP |
| `packages/protocol` | Runtime / UI wire contracts |
| `packages/storage` | Local storage paths, session persistence |
| `packages/cli` | CLI entrypoint (`codelia`) |
| `crates/tui` | Rust TUI client |

## Requirements

- [Bun](https://bun.sh/)
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

Credentials are stored locally under `~/.codelia/`. To sign out, use `/logout` in the TUI.

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

| Command | Description |
|---|---|
| `bun run test` | Run tests |
| `bun run typecheck` | Type checking |
| `bun run fmt` | Format (Biome) |
| `bun run check:deps` | Dependency hygiene |
| `bun run check:versions` | Workspace version sync |

## Examples

| Example | Description |
|---|---|
| [`examples/basic-web`](examples/basic-web/) | Minimal web chat UI with React + Hono, SSE streaming |
| [`examples/basic-cli`](examples/basic-cli/) | Legacy `@codelia/core` direct-usage CLI |

## Docs

- Architecture: [`docs/typescript-architecture-spec.md`](docs/typescript-architecture-spec.md)
- Specs: [`docs/specs/`](docs/specs/) (may include planned or partially implemented items)
