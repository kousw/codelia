# Production local image preview

Contract and operation guide: `dev-docs/specs/tui-image-preview.md`.

- `mod.rs`: bounded controller, generation-aware result application, key ownership.
  Its intent revision changes on open/reopen/close/forget and fences artifact RPCs
  separately from worker generation; keep cached worker output reusable on close
  and reopen. A failed reopen without a source does not change intent.
- `decode.rs`: shared file/byte decoder and safe labels; the standalone lab imports
  this module by path, so keep it independent of app/runtime code.
- `policy.rs`: pure query-free halfblocks/explicit alternate-only Kitty selection.
- `worker.rs`: one lazy channel-owned worker for load/decode/resize/encode.
- `tests.rs`: real view/worker lifecycle, format limits, stale completion, composer
  preservation and Kitty identity tests; also shares fixtures with inline replay.
- View lives in `app/view/ui/image_preview.rs`; handlers live in
  `app/handlers/image_preview.rs`. `entry/run_loop.rs` owns polling/preemption.

Run `cargo test --manifest-path crates/tui/Cargo.toml --locked image_preview` and
`python3 scripts/check-tui-image-preview.py crates/tui/target/debug/codelia-tui`
after building the actual TUI. Existing scrollback ANSI capture now includes
preview-open/close cases. Native pixels remain a separate manual acceptance gate.
