# Preview experiment rules

- No runtime/model/network calls, artifact-store mutation, or automatic external viewers.
- Preserve the production inline render path. Do not copy image protocol writes
  into its event loop without a separate design and scrollback verification.
- Keep terminal queries before normal input polling. In the pinned library, failed
  queries may leave an input reader alive, so exit instead of entering that loop.
- Refuse tmux before constructing any Picker: its fallback also mutates passthrough.
- Decode bounded local bytes before raw mode; resize/encode on the worker, not draw.
- Keep one pending encode request and bound source dimensions/allocation.
- Restore terminal state on normal exits, errors, and panics. Keep PTY processes
  owned and cleanup bounded; assertions must not leave a preview running.
- Keep native graphics manually unverified until exercised in the target terminal.
