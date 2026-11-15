# @codelia/config-loader

Config file I/O layer (cosmiconfig).

- Loads a single config file via `loadConfig(path)`.
- Parsing/validation lives in `@codelia/config`.
- `updateModelConfig()` updates `model.*` while preserving other fields.
- MCP update API: `loadMcpServers` / `upsertMcpServerConfig` / `removeMcpServerConfig` / `setMcpServerEnabled`.
- Permissions update API: `appendPermissionAllowRules` / `appendPermissionAllowRule` (duplicate rules are eliminated by identity check).

`updateConfigValue(path, keyPath, value | undefined)` sets or removes one scalar leaf, preserving unrelated raw JSON and pruning emptied parents; it validates the result with `parseConfig` before writing.
`removePermissionRules(path, kind, rule)` removes every structurally equal `permissions.<kind>` entry (same `isSameRule` as append), prunes emptied lists/objects, and returns the count (0 = no write).
Every exported read-modify-write helper runs under a per-path in-process queue (`withConfigFileLock`); new writers must use it so concurrent RPCs never drop each other's changes. Permission-rule removal compares `normalizePermissionRule` (parseConfig) forms.
