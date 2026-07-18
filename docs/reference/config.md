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
- `reasoning` accepts `low`, `medium`, `high`, `xhigh`, or `max`; runtime falls back to the nearest lower level when the selected model does not support the requested effort.
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
      "providers": ["openai", "anthropic", "xai"],
      "search_context_size": "medium",
      "allowed_domains": ["docs.example.com"]
    },
    "local": {
      "backend": "ddg",
      "brave_api_key_env": "BRAVE_SEARCH_API_KEY"
    },
    "xai": {
      "x_search": {
        "enabled": true,
        "allowed_x_handles": ["xai", "elonmusk"],
        "from_date": "2026-01-01",
        "to_date": "2026-07-19",
        "enable_image_understanding": false,
        "enable_video_understanding": false
      }
    }
  }
}
```

`search.xai.x_search` is an xAI-only, explicit opt-in and defaults to disabled.
It is independent of `search.mode`, which continues to select native or local
web search. `allowed_x_handles` and `excluded_x_handles` are mutually exclusive
and accept at most 20 handles; a leading `@` is optional and removed before the
request. Dates use inclusive `YYYY-MM-DD` boundaries. Image and video
understanding are separately opt-in because they may increase latency and token
usage.

Native web-search options are provider-specific. xAI ignores
`search_context_size` and `user_location` because its Responses Web Search tool
does not support those OpenAI-oriented fields; supported domain filters are
still preserved.

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
