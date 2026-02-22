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
