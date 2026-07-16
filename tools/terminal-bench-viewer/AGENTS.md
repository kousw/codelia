# terminal-bench-viewer

- Local-only read-only viewer for Harbor job outputs.
- The server binds to `127.0.0.1` by default. Remote access is opt-in through
  `CODELIA_TERMINAL_BENCH_VIEWER_HOST` (for example, `0.0.0.0`) and should only
  be used on a trusted network because job artifacts may contain sensitive data.
- Data source is resolved from `config.json` plus optional `config.local.json`.
- Keep filesystem parsing on the server side; the client should consume normalized API payloads only.
- Prefer additive viewer-specific behavior; do not change `tools/terminal-bench` runner semantics.
- Agent discovery entrypoint is `GET /api/schema`; keep it aligned with the actual route behavior.
- Treat each `datasetLabel` as a separate benchmark scope. Terminal-Bench 2.0
  (`terminal-bench@2.0`) and Harbor 2.1
  (`terminal-bench/terminal-bench-2-1`) must not be mixed in job comparison,
  task aggregate, or task history views. Analysis API routes require
  `dataset_label`; only `/api/jobs` may be unscoped for discovery.
