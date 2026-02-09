# @codelia/config

Config schema + registry (no I/O).

- `ConfigRegistry` registers defaults from modules and merges with loaded config.
- `config.version` is required and currently must be `1`.
- Initial schema supports `model.provider`, `model.name`, `model.reasoning`, `model.verbosity`.
- Schema now includes `permissions.allow` / `permissions.deny` with tool rules and optional bash `command` / `command_glob`.
- `permissions` rule supports `skill_name` for `tool: "skill_load"` to allow/deny per skill name.
- Schema now includes `mcp.servers` (`http`/`stdio`) with project override merge by server id.
- Schema now includes `skills.enabled`, `skills.initial.*`, `skills.search.*`.
- `mcp.servers` の server id は `^[a-zA-Z0-9_-]{1,64}$` のみ有効。無効 id は parse 時に除外する。
- HTTP MCP server は `oauth.token_url/client_id/client_secret/scope` の refresh 設定を持てる。
