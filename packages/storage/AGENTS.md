# packages/storage

## Notes

- Resolves Codelia storage paths with a default home layout under `~/.codelia`.
- XDG layout is opt-in via `CODELIA_LAYOUT=xdg` and splits config/cache/state paths.
- Config path set includes `config.json` / `auth.json` / `mcp-auth.json`.
- `McpAuthStore` が `mcp-auth.json` の read/write と正規化（permission `0600`）を提供し、runtime/cli から共通利用される。
- `StoragePathServiceImpl` implements the core `StoragePathService` DI interface.
- Session logs live under `sessions/YYYY/MM/DD/` and are written by `SessionStoreWriterImpl`.
- `RunEventStoreFactoryImpl` creates per-run `SessionStoreWriterImpl` instances for runtime DI.
- Session resume snapshots live under `sessions/state/` and are written via `SessionStateStoreImpl`.
