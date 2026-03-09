# terminal-bench-viewer

- Local-only read-only viewer for Harbor job outputs.
- Data source is resolved from `config.json` plus optional `config.local.json`.
- Keep filesystem parsing on the server side; the client should consume normalized API payloads only.
- Prefer additive viewer-specific behavior; do not change `tools/terminal-bench` runner semantics.
- Agent discovery entrypoint is `GET /api/schema`; keep it aligned with the actual route behavior.
