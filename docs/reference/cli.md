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

## TUI startup options

These flags are passed through to the TUI launcher:

| Option | Meaning |
|---|---|
| `-r`, `--resume [session_id]` | Resume through the latest/session picker flow, or resume a specific session id |
| `--debug[=true\|false]` | Enable debug runtime/RPC log lines |
| `--diagnostics[=true\|false]` | Expand per-call LLM telemetry into transcript lines |
| `--initial-message <text>` | Queue an initial prompt |
| `--initial-user-message <text>` | Alias of `--initial-message` |
| `--tui-mode <auto\|inline\|alternate>` | Select terminal buffer mode (`auto` default, `inline`, or `alternate`) |
| `--color-scheme <dark\|light>` | Select accent palette (`dark` or `light`, overrides `tui.color_scheme`) |
| `--image-protocol <halfblocks\|kitty>` | Select local image preview protocol (`halfblocks` default, or `kitty`) |
| `--debug-perf[=true\|false]` | Enable the live perf footer bar |
| `--sandbox-mode <mode>` | Select `readonly`, `workspace-write` (default) or `full-access`. Full access runs as the current user after command approval. |

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

## macOS Keychain access after an update

If Codelia reports `macOS Keychain operation timed out` or denies access to saved credentials, open a local terminal on the Mac and run the following command with the same Codelia configuration. If the Keychain is locked, unlock it first.

```sh
codelia auth authorize-keychain
```

macOS may ask whether `/usr/bin/security` can read a Codelia item, particularly after an upgrade from the bundled helper. Choose **Allow** for this request or **Always Allow** to remember that choice for the item.

The command reports a result for each credential store. `access granted` means the saved credentials are readable. `no item found` means that store has no saved item for this configuration, which is normal if you have never signed into an MCP server or provider. Retry the original operation after granting access.

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

`codelia mcp auth set` reuses the configured HTTP server `url` when present; pass `--url <server-url>` to override it or when no URL is configured (for example, undefined or stdio server IDs). A refresh token also needs a token endpoint, supplied by OAuth discovery, configuration, or `--token-url`.

## `update` command

Check for a newer `@codelia/cli` release or apply an in-place update for supported global npm installations:

```sh
codelia update --check
codelia update
```

Non-npm installations (such as Homebrew, Nix, pnpm, Bun, Yarn, Volta, mise, or source checkouts) print the appropriate manual update hint instead of modifying files automatically.

## `session` commands

Manage saved session lifecycle and run-log retention from the terminal:

```sh
codelia session list
codelia session pin <session_id>
codelia session unpin <session_id>
codelia session archive <session_id>
codelia session unarchive <session_id>
codelia session cleanup
```

See [`../session-storage.md`](../session-storage.md) for retention and compression rules.

## Related docs

- Getting started: [`../getting-started.md`](../getting-started.md)
- Config reference: [`config.md`](./config.md)
- Environment variables: [`env-vars.md`](./env-vars.md)
- User docs index: [`../README.md`](../README.md)
- Developer/internal docs: [`../../dev-docs/README.md`](../../dev-docs/README.md)
