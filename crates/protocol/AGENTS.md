# codelia-protocol

Standalone Rust library shared by UI clients. Use a Cargo path dependency on
`crates/protocol`. Rust 1.93.1 is the minimum supported version and CI tests
it with the crate's lockfile. Consumers use their own Cargo.lock files.

- `generated.rs` is produced by `bun run generate:protocol`; never edit it by
  hand. Its public types and method markers are re-exported through `lib.rs`.
- `lib.rs` owns the JSON-RPC envelope and handwritten serde helpers. Use
  `IncomingMessage::classify` for the envelope, the generated request and
  notification decoders for params, and `decode_result::<methods::X>` for a
  correlated reply. Serialize with `request_line`, `notification_line`,
  `reply_line`, or `error_reply_line`.
- Report `DecodeError` through its redacted `Display` and continue processing
  the stream. Known malformed payloads return errors. Unknown methods and new
  string tag values use `Unknown` (or `Other` if `"unknown"` is a wire value).
  Each host owns request rejection and diagnostic presentation.
- `serde_json/float_roundtrip` preserves safe integers written as decimals
  or exponents. Cargo unifies this feature for consumers that resolve the
  same `serde_json` version, including the TUI's initial JSON parser.
- Run `cargo test --locked --manifest-path crates/protocol/Cargo.toml` to replay
  the shared fixtures in `packages/protocol/tests/fixtures/`, including Steer.
  See `dev-docs/specs/protocol-codegen.md` for the contract.
