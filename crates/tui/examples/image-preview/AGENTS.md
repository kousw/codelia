# Image preview lab

This is an opt-in standalone experiment, not a production TUI feature. Read
`README.md` for commands, controls, limits, and manual visual acceptance.

- `main.rs`: argument parsing, terminal lifecycle, query guard, encoder worker.
- `source.rs`: demo image and adapter over the production `src/app/image_preview/decode.rs` decoder.
- `ui.rs`: small panel/modal/hidden layout and input transitions.
- `tests.rs`: CLI, loading, layout, halfblock render/hide/resize tests.
- `smoke.py`: macOS/Linux PTY lifecycle and emulated Kitty protocol smoke.

The `image-preview` Cargo feature gates this standalone example, not production
dependencies: normal TUI builds now include the separate local preview feature.
Do not interpret PTY emission as proof of native terminal pixels or inline history
compatibility. TestBackend validates halfblock cells, not Kitty/Sixel/iTerm2 display.
The artifact/remote/runtime integration remains planned in the main image spec.
