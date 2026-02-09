# packages/storage

## Notes

- Resolves Codelia storage paths with a default home layout under `~/.codelia`.
- XDG layout is opt-in via `CODELIA_LAYOUT=xdg` and splits config/cache/state paths.
- Config path set includes `config.json` / `auth.json` / `mcp-auth.json`.
- `McpAuthStore` provides read/write and normalization (permission `0600`) for `mcp-auth.json` and is commonly used by runtime/cli.
- `StoragePathServiceImpl` implements the core `StoragePathService` DI interface.
- Session logs live under `sessions/YYYY/MM/DD/` and are written by `SessionStoreWriterImpl`.
- `RunEventStoreFactoryImpl` creates per-run `SessionStoreWriterImpl` instances for runtime DI.
- Session resume snapshots live under `sessions/state/` and are written via `SessionStateStoreImpl`.
