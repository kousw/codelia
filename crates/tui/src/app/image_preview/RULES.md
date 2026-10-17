# Image preview implementation rules

- This is explicit TUI-local display, not model-callable file access. Do not infer
  local paths from remote runtime output or add downloads/uploads here.
- Keep runtime events and user input responsive: no file read, decode, resize, or
  encode in the draw/key/tick path. One worker, one in-flight job, one latest pending
  source; move the protocol instead of cloning decoded images for resize.
- Closing, preemption, or session reset must not be undone by a stale result.
- Keep original bytes unchanged; share byte/pixel/decoder limits across file and
  attachment paths. Preserve original dimensions separately from preview dimensions.
- Default to query-free halfblocks. Never construct ratatui-image Picker in the
  production process: its input-reader/tmux behavior is inappropriate mid-session.
- Kitty requires explicit opt-in, alternate mode, no multiplexer, and safe OS cell
  metrics. Keep one owned image ID; delete only that ID at terminal teardown.
- View composition writes only to the Ratatui frame. Never place graphics in the
  log cache or bypass inline insert/restore bookkeeping with backend writes.
- Preview owns all input while open, but yields to runtime dialogs and panels.
- Automated cell/protocol checks do not establish native visual correctness.
