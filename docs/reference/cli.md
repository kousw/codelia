# CLI reference

This page documents the currently implemented CLI entrypoints.
The main user workflow is the TUI; use this page as a supporting reference.

## Top-level usage

```text
usage: codelia [options] [-- <tui-options>]
```

## Top-level options

| Option | Meaning |
|---|---|
| `-h`, `--help` | Show top-level help |
| `-V`, `-v`, `--version` | Show the CLI version |
| `-p`, `--prompt <text>` | Run one headless prompt and exit |
| `--sandbox-mode <mode>` | Select `readonly`, `workspace-write` (default) or `full-access`. Full access runs as the current user after command approval. |
| `--approval-mode <mode>` | Legacy input. `trusted` selects workspace writes and honors shared project allows. Legacy `full-access` starts confined. To disable OS isolation, set `--sandbox-mode full-access`. |

## TUI startup options

These flags are passed through to the TUI launcher:

| Option | Meaning |
|---|---|
| `-r`, `--resume [session_id]` | Resume through the latest/session picker flow, or resume a specific session id |
| `--debug[=true|false]` | Enable debug runtime/RPC log lines |
| `--diagnostics[=true|false]` | Enable per-call LLM diagnostics |
| `--initial-message <text>` | Queue an initial prompt |
| `--initial-user-message <text>` | Alias of `--initial-message` |
| `--debug-perf[=true|false]` | Enable the perf panel |
| `--sandbox-mode <mode>` | Select `readonly`, `workspace-write` (default) or `full-access`. Full access runs as the current user after command approval. |
| `--approval-mode <mode>` | Legacy input. `trusted` selects workspace writes and honors shared project allows. Legacy `full-access` starts confined. To disable OS isolation, set `--sandbox-mode full-access`. |

Examples:

```sh
codelia
codelia --resume
codelia --resume 2026-03-07-example-session
codelia --initial-message "Review the latest changes"
codelia --diagnostics
```

## Prompt mode

Run a single headless request:

```sh
codelia --prompt "Summarize the current branch"
```

See [tool approval and local execution](../command-approval.md) for the current approval flow.

## MCP commands

The MCP command group currently supports config management and auth token management.

### Overview

```text
codelia mcp <add|list|remove|enable|disable|test|auth> ...
```

### `mcp list`

List configured servers.

```sh
codelia mcp list
codelia mcp list --scope effective
codelia mcp list --scope project
codelia mcp list --scope global
```

Supported scopes:
- `effective` (default)
- `project`
- `global`

### `mcp add`

Add or replace an MCP server config.

```text
codelia mcp add <server-id> --transport <http|stdio> ...
```

Common flags:
- `--scope <project|global>`
- `--replace`
- `--enabled true|false`
- `--request-timeout-ms <ms>`

HTTP transport flags:
- The CLI/config value is `http`; the current implementation behind it is Streamable HTTP.
- `--url <url>`
- `--header key=value` (repeatable)
- `--oauth-authorization-url <url>`
- `--oauth-token-url <url>`
- `--oauth-registration-url <url>`
- `--oauth-client-id <value>`
- `--oauth-client-secret <value>`
- `--oauth-scope <value>`

stdio transport flags:
- `--command <path-or-command>`
- `--arg <value>` (repeatable)
- `--cwd <path>`
- `--env key=value` (repeatable)

Examples:

```sh
codelia mcp add local-demo --transport stdio --command uvx --arg my-mcp
codelia mcp add remote-demo --transport http --url https://example.com/mcp --scope global
```

### `mcp remove`, `mcp enable`, `mcp disable`

```text
codelia mcp remove <server-id> [--scope project|global]
codelia mcp enable <server-id> [--scope project|global]
codelia mcp disable <server-id> [--scope project|global]
```

### `mcp test`

Probe a configured MCP server.

```text
codelia mcp test <server-id> [--scope effective|project|global]
```

The HTTP probe attaches a saved bearer token after confirming its destination and OAuth binding.
Stdio probes use the runtime's confined launcher and pass the configured environment only to the service. A probe therefore also checks whether the runtime can launch the server with its configured sandbox.

### `mcp auth`

Manage MCP auth tokens in the configured credential store.

```text
codelia mcp auth <list|set|clear> ...
```

Commands:

```text
codelia mcp auth list
codelia mcp auth set <server-id> --access-token <token> [--url <server-url>] [--issuer <issuer>] [--token-url <url>] [--client-id <id>] [--refresh-token <token>] [--expires-at <epoch_ms>] [--expires-in <sec>] [--scope <scope>] [--token-type <type>]
codelia mcp auth clear <server-id>
```

Use the configured MCP server URL for `--url`. A refresh token also needs a token endpoint, supplied by OAuth discovery, configuration, or `--token-url`.

### macOS Keychain access after an update

If Codelia reports that its helper needs authorization to access an existing item, run `codelia auth authorize-keychain` in a local macOS terminal. Start in a project directory separate from the installation and credential store. A workspace rooted at your home directory can include both paths and prevent helper verification. The command identifies each Codelia service for the current configuration and gives you time to answer the macOS prompt. Choosing **Always Allow** remembers the verified helper for that item. If Codelia reports that the Keychain is locked, unlock it first.

## Related docs

- Getting started: [`../getting-started.md`](../getting-started.md)
- Config reference: [`config.md`](./config.md)
- Environment variables: [`env-vars.md`](./env-vars.md)
- User docs index: [`../README.md`](../README.md)
- Developer/internal docs: [`../../dev-docs/README.md`](../../dev-docs/README.md)
