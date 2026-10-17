# Image preview lab

Experimental standalone Ratatui example. It does not start the Codelia runtime,
call a model, upload images, or change production TUI/history behavior. It renders
a small image panel or a centered modal in the same alternate-screen terminal.
The background is sample text, not actual conversation history.

## Run from the repository root

In-memory demo (no image file required):

```sh
cargo run --manifest-path crates/tui/Cargo.toml --locked \
  --features image-preview --example codelia-image-preview
```

Your own local image:

```sh
cargo run --manifest-path crates/tui/Cargo.toml --locked \
  --features image-preview --example codelia-image-preview -- /absolute/path/image.png
```

Deterministic halfblock rendering, without terminal capability queries:

```sh
cargo run --manifest-path crates/tui/Cargo.toml --locked \
  --features image-preview --example codelia-image-preview -- --halfblocks
```

An explicit `--` after example options allows filenames starting with `-`.
The optional `image-preview` feature enables this example. `ratatui-image` 11.0.8
is now also used by the separate production local-preview feature, with default
features disabled (no chafa dependency). The lab shares its bounded decoder with
production but retains its own protocol detection and terminal lifecycle.

## Controls and display

- `Enter` / `Space`: small panel to modal, or modal back to small panel.
- `Esc`: close the modal to the small panel; otherwise hide the image.
- `v`: hide/show the small panel.
- `q` / `Ctrl+C`: quit and restore the terminal.
- Resize the terminal to compare layouts. At less than 24 x 10 cells, show text
  rather than attempting an image render.

The header reports the selected protocol and current view. The source path and
original dimensions remain text, independently of image rendering. Halfblocks are
colored text cells, not the native-resolution graphics protocol. Large previews
preserve aspect ratio. No external-open, clipboard, or remote-download action is
implemented in this lab.

## Safety and support boundaries

- Local PNG/JPEG/GIF/WebP only (first frame, no animation). Files must be regular
  files, at most 8 MiB, at most 4096 pixels per side / 16 megapixels, and within a
  96 MiB decoder allocation limit. The retained RGBA preview is at most 1024 pixels
  per side; small images are not upscaled during loading. Originals are not changed.
- Decode before entering the interactive loop. Terminal resize/encoding uses a
  worker with one pending request; redraw never decodes or encodes the source.
- Default protocol detection happens before normal input polling. An unanswered
  query exits with an instruction to retry `--halfblocks`: the pinned library can
  otherwise leave its query stdin reader alive after timeout.
- Run outside tmux. The pinned library's picker can set pane passthrough even when
  constructing its halfblock fallback. The lab refuses before invoking it, rather
  than changing the user's multiplexer settings. Native tmux support is not tested.
- Auto detection may select Kitty, Sixel, iTerm2, or halfblocks, but availability
  is not a promise of correct visual cleanup on every terminal.
- This is not an inline/native scrollback experiment. The separate production
  `/image` and `Alt+I` feature uses query-free halfblocks or explicit alternate-only
  Kitty; see `dev-docs/specs/tui-image-preview.md`. Remote artifact access and
  durable image-history integration remain planned.

Library reference: [ratatui-image 11.0.8](https://docs.rs/ratatui-image/11.0.8/ratatui_image/).

## Automated checks

```sh
cargo test --manifest-path crates/tui/Cargo.toml --locked \
  --features image-preview --example codelia-image-preview
cargo build --manifest-path crates/tui/Cargo.toml --locked \
  --features image-preview --example codelia-image-preview
python3 crates/tui/examples/image-preview/smoke.py \
  crates/tui/target/debug/examples/codelia-image-preview
cargo test --manifest-path crates/tui/Cargo.toml --locked
```

The Python PTY smoke uses only the standard library and runs on macOS/Linux. It
checks real process input, panel/modal/hide/show, resize, protocol emission, and
terminal-mode restoration, including a query timeout. Kitty capability replies are
emulated; this does not verify actual native pixels or terminal graphics cleanup.
The Rust TestBackend test does render halfblock cells and verifies hide/resize.

## Manual visual acceptance (still required)

1. Run in the intended terminal outside tmux; note protocol and terminal version.
2. Confirm the demo's checkerboard and orange circle look correct in both views.
3. Toggle modal, close/hide/show repeatedly, and resize large/small. Look for stale
   graphics, disappearing images, text corruption, and input lag.
4. Quit and verify the original terminal screen, cursor, echo, and input behavior.
5. Try a local image with text/details and compare the original externally.
6. Repeat with `--halfblocks` to distinguish application layout from native graphics
   issues. Native Kitty/Sixel/iTerm2 visual behavior remains unverified until tested
   in the actual target terminal; successful PTY output alone is insufficient.
