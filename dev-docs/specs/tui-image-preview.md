# TUI local image preview

Status: Implemented (2026-09-13). Native terminal visual acceptance remains UNVERIFIED.

This is a production display feature in normal `crates/tui` builds. It uses
`ratatui-image` 11.0.8. `/image` and composer previews perform no runtime/model
operation. The [image-generation pipeline](image-generation.md#11-implemented-public-api-slice)
also provides explicit `/image-artifact <id>`: a bounded RPC fetch of saved PNG
bytes, then the same preview controller. No generation/upload is triggered by
previewing; runtime paths never masquerade as TUI-local paths over SSH.

## User contract

- `/image <local-path>` opens a small overlay; quote paths containing spaces.
  Paths are interpreted on the **TUI host**, including when runtime is over SSH.
  `~/` is expanded; other shell expressions are not evaluated. URLs are rejected.
- `/image` reopens the last source; after a load error it retries loading it.
- `Alt+I` previews the last image referenced by the current composer, without
  consuming the composer or its attachments. With no composer image, reopen the
  last preview. Previewing does not submit the attachment to a model.
- `Enter` / `Space` toggles small/large modal. `Esc` returns from modal to small,
  then closes. `q`, `v`, or `Ctrl+C` closes immediately. `Ctrl+C` while previewing
  does not cancel a running model request or quit the TUI.
- The overlay owns keys, paste and mouse events. Runtime events continue to be
  drained; permission/prompt/choice/picker panels preempt and close the preview.
  The user may reopen it afterward. Queued prompt dispatch pauses while open.
- Artifact RPCs capture the current preview intent revision. A newer local or
  composer preview, reopening a retained source, closing/preemption or forgetting
  the preview supersedes that request: its delayed success/error cannot replace
  the newer preview or reopen a dismissed one. Ordinary preview actions keep the
  RPC pending until normal response matching drains it; session reset retains its
  existing pending-RPC cleanup. Invalid local commands or reopening with no source
  do not supersede a request. Intent revisions are separate from worker generations
  so close/reopen preserves reusable decoded/encoded output.
- The preview is transient, not a log row or a durable image reference. One last
  source/decoded preview is retained for reopening; clearing the session log also
  forgets it. Session serialization/resume does not persist this UI state.
- Source path or attachment identity, original dimensions, and byte count are
  text metadata. Errors remain in a closable panel with a retry hint. Very small
  viewports use text instead of graphics. Original image bytes are not modified.

## Protocol policy

Default: query-free halfblocks (colored text cells), in both inline and alternate
modes, including tmux. Production code does not construct a `Picker`, launch a
capability-query reader, or modify multiplexer settings.

Native Kitty virtual images are explicit opt-in:

```sh
CODELIA_TUI_IMAGE_PROTOCOL=kitty cargo run --manifest-path crates/tui/Cargo.toml --locked -- --tui-mode alternate
```

This requires a compatible terminal outside tmux/screen, alternate-screen mode,
and a nonzero bounded pixel-cell size obtained from the OS through
`crossterm::terminal::window_size`. No stdin query is used to obtain these metrics.
Unknown protocol values, inline mode, multiplexer detection, or unavailable/unsafe
OS metrics select halfblocks with the reason shown in the panel. The current
Windows crossterm path cannot supply these pixel metrics and uses halfblocks.
`CODELIA_TUI_IMAGE_PROTOCOL=halfblocks` explicitly selects the default.

Only halfblocks and Kitty are enabled in production; Sixel/iTerm2 remain in the
standalone lab. No automatic compatibility claim is made for native graphics.
The Kitty path reuses one process-owned image ID for all loads/resizes. Clearing
placeholder cells hides the image; the last bounded terminal image is cached until
replacement or process teardown. `TerminalRestoreGuard` deletes only that owned
ID before leaving alternate screen, including error/unwind exits. It never issues
an unscoped delete-all command. SIGKILL cannot run Rust cleanup guards.

## Rendering and worker contract

- The overlay is drawn after normal UI composition through the Ratatui frame.
  Inline mode temporarily requests the available viewport height through existing
  sizing APIs, without entering alternate screen or writing directly to the backend.
- Existing `draw_frame` / `insert_before` / restoration policy is unchanged. The
  wrapped log cache contains only transcript text: neither halfblock cells nor Kitty
  placeholder/control sequences enter native scrollback through log insertion.
- A lazy, single worker performs file reading, bounded decode, RGBA conversion,
  protocol construction, resize and encoding. View code only projects layout and
  renders an already encoded protocol. A redraw records its desired image area;
  the following loop poll schedules work without blocking runtime/input polling.
- At most one job is in flight plus one replacement source request. Resize requests
  coalesce to the last drawn area. The owned protocol moves into the encode job;
  it is not cloned for each resize. Completion carries a generation and stale
  generations are discarded. Closing/preemption never reopens on completion.
- Worker/result channels have capacity one. Drop disconnects them rather than
  joining a file read on the UI thread. A disconnected worker is a recoverable
  preview error. There is no hard cancellation/deadline for OS file reads; a stalled
  local/network filesystem can stall this worker, but not the event loop. A new
  load waits for its predecessor instead of spawning unbounded workers.

## Resource boundaries

- Regular local PNG/JPEG/GIF/WebP only, first frame, no animation.
- Encoded bytes <= 8 MiB; dimensions <= 4096 per side and <= 16 megapixels;
  decoder allocation limit 96 MiB; retained RGBA preview <= 1024 per side.
- Small source images are not upscaled during loading. Original dimensions remain
  metadata even when a reduced preview is retained.
- Attachment base64 length is bounded before decode, and decoded bytes use the same
  byte/dimension/format limits as file input.
- File kind is checked before and after open; on Unix `O_NONBLOCK` also prevents a
  swapped FIFO from blocking at open. Paths are user-selected local inputs, not an
  agent-callable file-access authorization boundary.
- Terminal labels are length bounded, with controls and bidi overrides escaped.
  Model-provided remote paths are never automatically opened as local files.

## Evidence and remaining gates

Implemented paths:

- `crates/tui/src/app/image_preview/`: controller, shared decoder, policy, worker.
- `crates/tui/src/app/handlers/image_preview.rs`: local command/attachment routing.
- `crates/tui/src/app/view/ui/image_preview.rs`: small/modal view.
- `crates/tui/src/entry/run_loop.rs`: input ownership, preemption, worker polling.
- `crates/tui/src/entry/terminal.rs`: query-free policy and terminal teardown.

Checks:

```sh
cargo test --manifest-path crates/tui/Cargo.toml --locked
cargo test --manifest-path crates/tui/Cargo.toml --locked --features image-preview --example codelia-image-preview
cargo build --manifest-path crates/tui/Cargo.toml --locked
python3 scripts/check-tui-image-preview.py crates/tui/target/debug/codelia-tui
```

The production PTY check uses a fake protocol peer, not a real account. It checks
local file display, small/modal/resize, runtime-event delivery and permission
preemption, error recovery, input isolation/no `run.start`, native cache reuse and
owned-ID cleanup, and termios/screen restoration. It exercises default inline,
alternate halfblocks, opt-in Kitty, and inline/multiplexer fallback.

The `inline_native_scrollback_ansi_capture` fixture also runs with a preview open
while appending bulk/chunked/streamed logs. The existing headless-xterm verifier
compares the entire resulting buffer, styles, composer, and cursor after close,
not just history markers. See [scrollback validation](tui-inline-scrollback-validation.md).

**UNVERIFIED:** actual native pixels and visual cleanup in the user's terminal,
font-zoom changes after startup, and native terminal implementations other than
those manually exercised. Verify small/modal/close and terminal resize with both
native Kitty and halfblocks before treating native output as generally supported.
Artifact browsing, automatic image-output previews, open/copy actions and durable
inline thumbnails remain outside this feature. Explicit generated-artifact RPC
transfer is implemented; runtime `image_export` is a separate permission-gated
tool, not an implicit preview action.
