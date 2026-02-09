# @codelia/config-loader

Config file I/O layer (cosmiconfig).

- Loads a single config file via `loadConfig(path)`.
- Parsing/validation lives in `@codelia/config`.
- `updateModelConfig()` updates `model.*` while preserving other fields.
- MCP 更新 API: `loadMcpServers` / `upsertMcpServerConfig` / `removeMcpServerConfig` / `setMcpServerEnabled`。
- permissions 更新 API: `appendPermissionAllowRules` / `appendPermissionAllowRule`（重複 rule は同一判定で排除）。
