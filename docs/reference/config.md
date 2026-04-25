# Config reference

This page documents the current user-facing configuration model for Codelia.
For most users, the important idea is simple:

- there is a global config file
- there can also be a project config file
- project config wins when both define the same setting

## Config files

Global config:
- default path: `~/.codelia/config.json`
- with `CODELIA_LAYOUT=xdg`: `~/.config/codelia/config.json`
- override path: `CODELIA_CONFIG_PATH=/path/to/config.json`

Project config:
- `<repo>/.codelia/config.json`

Both files use JSON and currently require:

```json
{
  "version": 1
}
```

## Merge behavior

Codelia resolves effective config as:
- built-in defaults
- global config
- project config

When the same field appears in both global and project config, the project value wins.

For list-like permission rules, allow/deny entries are combined rather than replaced.
For MCP servers, project servers override global servers with the same server id.

## Minimal example

```json
{
  "version": 1,
  "model": {
    "provider": "openai",
    "name": "gpt-5.2-codex",
    "reasoning": "medium",
    "verbosity": "medium",
    "fast": true
  },
  "tui": {
    "theme": "ocean"
  }
}
```

## Main config groups

### `model`

Choose the default model used by the runtime.

```json
{
  "version": 1,
  "model": {
    "provider": "openai",
    "name": "gpt-5.2-codex",
    "reasoning": "medium",
    "verbosity": "medium",
    "fast": true
  }
}
```

Fields:
- `provider`
- `name`
- `reasoning`
- `verbosity`
- `fast` enables provider-specific fast mode only when the selected model declares fast support; unsupported models behave as if fast is disabled.

### `experimental`

Current supported key:

```json
{
  "version": 1,
  "experimental": {
    "openai": {
      "websocket_mode": "auto"
    }
  }
}
```

Allowed values for `experimental.openai.websocket_mode`:
- `off`
- `auto`
- `on`

### `permissions`

Use this to pre-allow or deny tool usage rules.

```json
{
  "version": 1,
  "permissions": {
    "allow": [
      { "tool": "read" },
      { "tool": "skill_load", "skill_name": "release-check" }
    ],
    "deny": [{ "tool": "bash", "command": "rm" }]
  }
}
```

Rule fields:
- `tool`
- `command`
- `command_glob`
- `skill_name`

### `mcp`

Configure MCP servers.

```json
{
  "version": 1,
  "mcp": {
    "servers": {
      "local-demo": {
        "transport": "stdio",
        "command": "uvx",
        "args": ["my-mcp"]
      },
      "remote-demo": {
        "transport": "http",
        "url": "https://example.com/mcp",
        "request_timeout_ms": 30000
      }
    }
  }
}
```

Notes:
- `transport` is `stdio` or `http`
- the current `http` implementation is Streamable HTTP
- server ids must match `^[a-zA-Z0-9_-]{1,64}$`
- `enabled` defaults to true when omitted

See [`../mcp.md`](../mcp.md) for workflow-oriented MCP docs.

### `skills`

Control skill discovery and catalog/search limits.

```json
{
  "version": 1,
  "skills": {
    "enabled": true,
    "initial": {
      "maxEntries": 200,
      "maxBytes": 32768
    },
    "search": {
      "defaultLimit": 8,
      "maxLimit": 50
    }
  }
}
```

### `search`

Control web/search behavior.

```json
{
  "version": 1,
  "search": {
    "mode": "auto",
    "native": {
      "providers": ["openai", "anthropic"],
      "search_context_size": "medium",
      "allowed_domains": ["docs.example.com"]
    },
    "local": {
      "backend": "ddg",
      "brave_api_key_env": "BRAVE_SEARCH_API_KEY"
    }
  }
}
```

### `tui`

Current supported user-facing key:

```json
{
  "version": 1,
  "tui": {
    "theme": "forest"
  }
}
```

At startup, a configured TUI theme overrides the default theme selection.
See [`../themes.md`](../themes.md) for the supported theme names and `/theme` workflow.

## Approval mode is stored separately

Approval mode is important, but it is not stored in `config.json`.
Codelia resolves it separately using:
- `--approval-mode`
- `CODELIA_APPROVAL_MODE`
- global `projects.json` project/default entries
- startup selection
- fallback `minimal`

Global approval-policy storage file:
- default: `~/.codelia/projects.json`
- with `CODELIA_LAYOUT=xdg`: `~/.config/codelia/projects.json`

## Related docs

- Environment variables: [`env-vars.md`](./env-vars.md)
- Themes: [`../themes.md`](../themes.md)
- CLI reference: [`cli.md`](./cli.md)
- Getting started: [`../getting-started.md`](../getting-started.md)
- MCP: [`../mcp.md`](../mcp.md)
