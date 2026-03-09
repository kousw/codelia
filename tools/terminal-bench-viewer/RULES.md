# terminal-bench-viewer Rules

- Treat Harbor output directories as read-only input.
- Keep path resolution explicit and based on the config file location.
- Normalize partial/unreadable job states on the server; do not duplicate parsing logic in the client.
- Favor dense comparison UI over decorative layouts.
