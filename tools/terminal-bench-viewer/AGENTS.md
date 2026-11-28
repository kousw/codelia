# tools/terminal-bench-viewer

Local-only read-only viewer for Harbor job outputs.

- Treat Harbor output directories strictly as read-only input, resolving paths explicitly from `config.json` / `config.local.json`.
- Bind `127.0.0.1` by default (`CODELIA_TERMINAL_BENCH_VIEWER_HOST` is opt-in for trusted networks only).
- Normalize partial/unreadable jobs on the server (`GET /api/schema` is the agent discovery entrypoint; keep parsing out of the client).
- Never mix distinct `datasetLabel` scopes (`terminal-bench@2.0` vs `terminal-bench/terminal-bench-2-1`); require `dataset_label` on analysis routes (only `/api/jobs` may be unscoped).
