# TUI commands

- Keep slash-command routing in `../command.rs` and focused behavior in this directory.
- `session.rs` implements capability-gated `/session` lifecycle updates; match and
  clear RPC ownership through `RpcPendingState` before applying responses.
- Pin/archive flags are independent. Archive can compress unpinned run history and expire explicit diagnostics, but
  must preserve resume context and referenced data. Use server results for status.
