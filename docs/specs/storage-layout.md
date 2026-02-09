# Storage Layout Spec

This document defines the on-disk layout for Codelia local data.

## 1. Goals

- Provide a single place for local config, cache, sessions, and logs.
- Keep defaults simple (`~/.codelia`) while allowing XDG layout opt-in.
- Store user-visible formats as JSON / JSONL / plain text.

## 2. Layouts

### 2.1 Home layout (default)

Root: `~/.codelia/`

```
~/.codelia/
  config.json
  auth.json
  mcp-auth.json
  cache/
    tool-output/
  sessions/
    state/
  logs/
```

### 2.2 XDG layout (opt-in)

Enable with `CODELIA_LAYOUT=xdg`.

- Config: `$XDG_CONFIG_HOME/codelia/` (or `~/.config/codelia/`)
- Cache: `$XDG_CACHE_HOME/codelia/` (or `~/.cache/codelia/`)
- State: `$XDG_STATE_HOME/codelia/` (or `~/.local/state/codelia/`)

```
$XDG_CONFIG_HOME/codelia/config.json
$XDG_CONFIG_HOME/codelia/auth.json
$XDG_CONFIG_HOME/codelia/mcp-auth.json
$XDG_CACHE_HOME/codelia/
$XDG_CACHE_HOME/codelia/tool-output/
$XDG_STATE_HOME/codelia/sessions/
$XDG_STATE_HOME/codelia/sessions/state/
$XDG_STATE_HOME/codelia/logs/
```

## 3. File formats

- `config.json`: JSON with a `version` field.
- `auth.json`: JSON (reserved, may be replaced by keychain later).
- `mcp-auth.json`: JSON (MCP HTTP auth token store; see `docs/specs/mcp.md` Phase 3).
- `sessions/`: JSONL (one event per line). See `docs/specs/session-store.md` for the record format.
- `cache/tool-output/`: tool output cache (storage area for redeploying with reference ID)
- `logs/`: plain text logs.

### 3.1 config.json (initial)

Precedence (highest first):
1. CLI arguments
2. Environment variables (if supported)
3. `config.json`
4. Defaults

Initial schema (minimum):
```json
{
  "version": 1,
  "model": {
    "provider": "openai",
    "name": "gpt-4.1-mini",
    "reasoning": "medium"
  }
}
```

Notes:
- `model.reasoning` is a provider-specific hint (e.g. "low" | "medium" | "high").
- Project-level config lives at `.codelia/config.json` and is loaded by runtime (CLI support is pending).
- `CODELIA_CONFIG_PATH` can override the global config file location.
- Defaults live in code and are registered by modules into a config registry used by CLI/runtime.

## 4. Windows

Windows uses the home directory layout by default (e.g. `C:\Users\<User>\.codelia`).

## 5. Implementation notes

- Storage path resolution lives in `@codelia/storage`.
- Consumers should create directories on demand; missing paths are not fatal.
