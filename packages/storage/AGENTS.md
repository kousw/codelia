# packages/storage

## Notes

- Resolves Codelia storage paths with a default home layout under `~/.codelia`.
- XDG layout is opt-in via `CODELIA_LAYOUT=xdg` and splits config/cache/state paths.
- Config path set includes `config.json` / `auth.json` / `mcp-auth.json` / `projects.json`.
- `ProjectsPolicyStore` provides read/write and strict schema validation for global `projects.json` (approval mode policy), using atomic write + `0600` permission (non-Windows chmod errors are surfaced).
- `McpAuthStore` provides read/write and normalization (permission `0600`) for `mcp-auth.json` and is commonly used by runtime/cli.
- `StoragePathServiceImpl` implements the core `StoragePathService` DI interface.
- Session logs live under `sessions/YYYY/MM/DD/` and are written by `SessionStoreWriterImpl`.
- `RunEventStoreFactoryImpl` creates per-run `SessionStoreWriterImpl` instances for runtime DI.
- Session resume uses `sessions/state.db` (SQLite index) + `sessions/messages/<session_id>.jsonl` (message payload) via `SessionStateStoreImpl`.
- `SessionStateStoreImpl` opens SQLite lazily on first DB use (not constructor time) to avoid test/runtime races when temp storage roots are removed quickly.
- Legacy snapshots under `sessions/state/<session_id>.json` are still readable and are migrated on load.
- `ToolOutputCacheStoreImpl.read` always returns a bounded truncated preview: long lines are clipped and oversized reads are truncated with continuation hints.
- `ToolOutputCacheStoreImpl.readLine` reads one physical line by character window (`line_number`, `char_offset`, `char_limit`) for huge single-line outputs.
- `ToolOutputCacheStoreImpl` caps are env-overridable: `CODELIA_TOOL_OUTPUT_CACHE_MAX_READ_BYTES` (default 65536), `CODELIA_TOOL_OUTPUT_CACHE_MAX_GREP_BYTES` (default 65536), `CODELIA_TOOL_OUTPUT_CACHE_MAX_LINE_LENGTH` (default 1000).
- `ToolOutputRef.line_count` from `ToolOutputCacheStoreImpl.save` is based on physical line count.
- `TaskRegistryStore` persists one JSON file per task under `<storage-root>/tasks/` (per-task files avoid shared-blob lost updates across runtimes).
- Persisted `TaskRecord` also carries optional public/display metadata (`key`, `label`, `title`, `working_directory`) so shell-task follow-up keys and status/list survive runtime restarts without depending on in-memory executor state.
