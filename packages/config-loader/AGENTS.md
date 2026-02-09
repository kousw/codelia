# @codelia/config-loader

Config file I/O layer (cosmiconfig).

- Loads a single config file via `loadConfig(path)`.
- Parsing/validation lives in `@codelia/config`.
- `updateModelConfig()` updates `model.*` while preserving other fields.
- MCP update API: `loadMcpServers` / `upsertMcpServerConfig` / `removeMcpServerConfig` / `setMcpServerEnabled`.
- Permissions update API: `appendPermissionAllowRules` / `appendPermissionAllowRule` (duplicate rules are eliminated by identity check).
