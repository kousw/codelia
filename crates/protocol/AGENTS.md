# codelia-protocol (`crates/protocol`)

Standalone Rust wire crate shared via Cargo path dependency (minimum supported Rust `1.93.1`, tested with crate lockfile in CI). Keep independent of UI state, runtime processes, and transports.

- `src/generated.rs` is produced by `bun run generate:protocol`; never edit it by hand.
- `src/lib.rs` owns JSON-RPC envelopes and handwritten serde helpers (`IncomingMessage::classify`, generated decoders, `decode_result::<methods::X>`, `request_line`/`notification_line`/`reply_line`/`error_reply_line`).
- Report `DecodeError` via redacted `Display` and keep processing the stream; unknown methods/new string tags decode to `Unknown` (`Other` if `"unknown"` is a wire value), while known malformed payloads fail.
- Keep `serde_json/float_roundtrip` so Cargo unifies safe integer decimal/exponent parsing across consumers.
- Replay shared fixtures (`packages/protocol/tests/fixtures/`, including Steer): `cargo test --locked --manifest-path crates/protocol/Cargo.toml` (run on minimum Rust `1.93.1` before raising it). Spec: `dev-docs/specs/protocol-codegen.md`.
