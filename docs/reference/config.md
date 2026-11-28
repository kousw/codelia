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

When the same field appears in both global and project config, the project value wins (except global-only settings such as `auth.storage` and `update.*`, which read only the global config).

For list-like permission rules, allow/deny entries are combined rather than replaced.
For MCP servers, project servers override global servers with the same server id.

## Minimal example

```json
{
  "version": 1,
  "model": {
    "provider": "openai",
    "name": "gpt-5.6",
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
    "name": "gpt-5.6",
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
- `fast` accepts `false` (default), `true` (silently behaves as disabled on unsupported models), or `"ultrafast"` (validated at model construction; errors on non-OpenAI or unsupported models).

### `subagent`

`max_concurrent` sets the runtime-wide simultaneous child limit (default `8`,
integer `1`–`16`). It excludes the parent and includes children from all owner
sessions in the runtime. A full runtime rejects new spawns; a slot becomes
available after a child exits and its cleanup finishes. Project configuration
overrides the global value. Restart the runtime to apply configuration changes.

There is no lifetime spawn quota: after a child finishes and cleanup releases its
slot, another child can start. Child execution has no default wall-clock deadline;
the parent may pass `task_spawn.timeout_seconds` (1–3600 seconds) when needed.
`task_wait` still returns after at most 120 seconds without stopping the child.
The separate step limit remains 50 by default (`task_spawn.max_steps`, 1–200).

Register purpose-specific model profiles for delegated agents. Profile names and
optional descriptions are shown to the parent agent so it can follow instructions
such as "use the research profile for this child".

```json
{
  "version": 1,
  "subagent": {
    "max_concurrent": 8,
    "default_profile": "implementation",
    "profiles": {
      "implementation": {
        "description": "Implement code changes",
        "model": { "provider": "openai", "name": "gpt-5.2-codex" }
      },
      "review": {
        "description": "Review code and investigate regressions",
        "model": { "provider": "anthropic", "name": "claude-sonnet-4-6", "reasoning": "high" }
      }
    }
  }
}
```

Choose model ids for which you have credentials and access. The example does not
configure credentials. Supported providers are `openai`, `anthropic`, `openrouter`,
`google`, `deepseek`, `moonshot`, `zai`, and `xai`.

Selection order:

1. The parent's explicit `task_spawn.model` or `task_spawn.profile` argument,
   including model/profile instructions relayed from your chat.
2. `subagent.default_profile`, if set.
3. The parent's complete model settings.

A profile model requires `name`; `provider` defaults to the parent provider.
Optional `reasoning`, `verbosity`, and `fast` use the same options as the main
model. Selecting a model or profile uses its own tuning/defaults; the parent's
model-specific tuning is inherited only when no selection or default exists.
Profiles without `default_profile` remain available for explicit selection.

Profile names use 1–64 letters, digits, underscores, or hyphens. Global and project
profiles merge by name, with a project entry replacing the entire same-named
profile. Restart the parent session to reload changed profile configuration.

There are no extra authentication probes or model-catalog requests before spawn.
Authentication and API errors are returned through the task, without automatic
model substitution. Child selection leaves the parent model unchanged.

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

Explicit deny rules still apply to tool admission. Save new launch rules through the structured approval screen. Positive entries in old config files are migration data.

```json
{
  "version": 1,
  "permissions": {
    "deny": [{ "tool": "shell", "command": "rm" }]
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

Supported keys:

```json
{
  "version": 1,
  "tui": {
    "theme": "forest",
    "color_scheme": "dark",
    "image_protocol": "halfblocks"
  }
}
```

- `theme`: built-in theme name (see [`../themes.md`](../themes.md))
- `color_scheme`: `"dark"` (default) or `"light"` (overridden per launch by `--color-scheme`)
- `image_protocol`: `"halfblocks"` (default) or `"kitty"` (overridden per launch by `--image-protocol`)

### `auth`

Configure credential storage and OAuth browser launch behavior:

```json
{
  "version": 1,
  "auth": {
    "storage": "auto",
    "oauth_browser": "auto"
  }
}
```

- `storage`: `"auto"` (default), `"keyring"`, or `"file"` — global `config.json` only (can also be overridden via `CODELIA_AUTH_STORAGE`)
- `oauth_browser`: `"auto"` or `"manual"` (defaults to manual over SSH)

### `agents`

Control `AGENTS.md` hierarchy discovery (enabled by default):

```json
{
  "version": 1,
  "agents": {
    "enabled": true
  }
}
```

### `update`

Global-only CLI self-update settings (project config is ignored):

```json
{
  "version": 1,
  "update": {
    "mode": "notify",
    "channel": "latest"
  }
}
```

- `mode`: `"notify"` (default), `"auto"`, or `"off"` (can be overridden by `CODELIA_AUTO_UPDATE`)
- `channel`: npm dist-tag to follow (inferred from the running version when omitted)

Note: `codelia update` and launcher checks read the standard global `config.json` (ignoring `CODELIA_CONFIG_PATH`), whereas `auth.storage` respects `CODELIA_CONFIG_PATH`.

### `execution_environment`

Configure lightweight startup probes captured into the initial execution-environment context:

```json
{
  "version": 1,
  "execution_environment": {
    "startup_checks": {
      "enabled": true,
      "mode": "append",
      "commands": [["node", "--version"]],
      "timeout_ms": 10000
    }
  }
}
```

- `startup_checks.enabled`: boolean (default `true`)
- `startup_checks.mode`: `"append"` (default; keeps built-in `["rg", "--version"]` plus `commands`) or `"replace"`. When project config sets `mode: "append"` explicitly alongside `commands`, project `commands` are concatenated after global `commands` (keeping built-in `["rg", "--version"]`). When project config sets only `commands`, project `commands` replace global `commands` while inheriting the effective `mode` (if global sets `"replace"` and project omits `mode`, `"replace"` stays in effect and built-in `["rg", "--version"]` is omitted; when effective `mode` is `"append"`, built-in `["rg", "--version"]` is preserved).
- `startup_checks.commands`: array of `[program, ...args]`
- `startup_checks.timeout_ms`: per-command timeout in milliseconds (default `10000`)

### `providers` & `image_generation`

- Custom named HTTP Responses endpoints are configured under `providers.<name>` — see [`../responses-providers.md`](../responses-providers.md).
- Image generation routing and provider options are configured under `image_generation` — see [`../image-generation.md`](../image-generation.md).

## Legacy approval policy

User-owned `projects.json` accepts `sandbox_mode` in project and default entries. An explicit CLI selection takes precedence over the environment, then project and default entries. Legacy `trusted` resolves to `workspace-write`. See [tool approval and local execution](../command-approval.md).

## Related docs

- Environment variables: [`env-vars.md`](./env-vars.md)
- Themes: [`../themes.md`](../themes.md)
- CLI reference: [`cli.md`](./cli.md)
- Getting started: [`../getting-started.md`](../getting-started.md)
- MCP: [`../mcp.md`](../mcp.md)
