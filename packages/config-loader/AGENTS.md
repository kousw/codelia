# @codelia/config-loader

Config file I/O layer (cosmiconfig).

- Loads a single config file via `loadConfig(path)`.
- Parsing/validation lives in `@codelia/config`.
- `updateModelConfig()` updates `model.*` while preserving other fields.
- MCP update API: `loadMcpServers` / `upsertMcpServerConfig` / `removeMcpServerConfig` / `setMcpServerEnabled`.
- Permissions update API: `appendPermissionAllowRules` / `appendPermissionAllowRule` (duplicate rules are eliminated by identity check).

`updateConfigValue(path, keyPath, value | undefined)` sets or removes one scalar leaf, preserving unrelated raw JSON and pruning emptied parents; it validates the result with `parseConfig` before writing.
`removePermissionRules(path, kind, rule)` removes every structurally equal `permissions.<kind>` entry (same `isSameRule` as append), prunes emptied lists/objects, and returns the count (0 = no write).
Every exported read-modify-write helper uses `withConfigFileLock` to queue in-process calls and hold a SQLite write lock on `<resolved-config-path>.lock.sqlite` from read through write. CLI and runtime writers must share this path; never delete the sidecar while another process can use it. A lock failure aborts the write. Permission-rule removal compares `normalizePermissionRule` (parseConfig) forms.

CI builds only `@codelia/core` before typechecking. Keep the source aliases for `@codelia/storage` and its shared types resolvable without their build outputs.
