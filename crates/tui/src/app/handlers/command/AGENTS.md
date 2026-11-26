# TUI commands

- Keep slash-command routing in `../command.rs` and focused behavior in this directory.
- `session.rs` implements capability-gated `/session` lifecycle updates; match and
  clear RPC ownership through `PendingRpcs` before applying responses.
- Pin/archive flags are independent. Archive can compress unpinned run history and expire explicit diagnostics, but
  must preserve resume context and referenced data. Use server results for status.

`/auto-approve [status|off]` delegates follow-mode or custom pinned reviewer setup to the runtime. Setup uses the existing picker. Selecting a mode enables Auto approve. Report the selected model and state on one line.
