# entry Rules

- Keep this layer as composition/bootstrap only; do not move domain state mutation rules here unless they are startup-specific.
- Prefer thin wrappers around `app::runtime` client calls; avoid duplicating protocol payload assembly.
- CLI parsing changes must preserve existing flag compatibility (`--flag`, `--flag=value`).
- Terminal lifecycle changes must preserve inline-mode behavior and cursor restoration guarantees.
