# TUI Local Image Preview (`crates/tui/src/app/image_preview/`)

Contract: `dev-docs/specs/tui-image-preview.md`.

- **Local display only**: Explicitly handles `/image` and `Alt+I` composer previews plus explicit `/image-artifact <id>` RPC transfers; never infer local paths from remote runtime output or initiate downloads/uploads.
- **Protocol policy (`policy.rs`)**: Default to query-free halfblocks. Never construct `ratatui-image` `Picker` in production (its stdin queries and tmux fallback break mid-session). Kitty requires explicit opt-in, alternate mode, no multiplexer, and safe OS pixel-cell metrics; allocate one owned image ID and delete only that ID at terminal teardown.
- **Worker & rendering (`mod.rs`, `decode.rs`, `worker.rs`)**: Run load/decode/resize/encode off the draw/key/tick path on a single worker (`decode.rs` stays independent of app/runtime for sharing with `crates/tui/examples/image-preview`). Track intent revision and worker generation so stale results cannot undo close, preemption, `clear_log`, or session reset; failed reopens without a source do not advance intent.
- **UI boundaries**: Preview consumes keys/paste/mouse while open, yields to runtime dialogs and panels, and renders over the Ratatui frame only — never insert preview cells into `WrappedLogCache` or call backend writes directly.
- **Lab & checks**: `crates/tui/examples/image-preview/` (`--features image-preview`) is an isolated experiment (`smoke.py` PTY checks do not prove native terminal pixels). Production checks: `cargo test --locked --manifest-path crates/tui/Cargo.toml image_preview` and `python3 scripts/check-tui-image-preview.py crates/tui/target/debug/codelia-tui`.
