# CLI commands

- Keep commands as product entry points; model/tool construction belongs to runtime.
- `session.ts` manages local pin/archive metadata and run-log compression/diagnostic expiry only.
  Its cleanup must preserve resume snapshots, reference data, tasks and usage.
- Validate subcommands and IDs before opening local stores. Do not trigger session
  cleanup from unrelated CLI commands or embedded hosts.
