# Authentication rules

- Credential mutations use `AuthStore.update()` to reload, mutate and save under
  its per-file process-local queue. Never save a stale resolver snapshot.
- Serialize refresh and persistence together; reload the current provider entry
  before sending a potentially rotated refresh token. A rejected refresh must
  leave saved credentials unchanged and release the queue.
- Provider-facing token errors carry static safe context and HTTP status. Only
  explicitly allowlisted OAuth codes may become diagnostic text; never forward
  token response bodies or infer authentication failures from raw message text.
