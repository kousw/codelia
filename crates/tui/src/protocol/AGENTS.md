# TUI wire protocol

`generated.rs` is produced by `bun run generate:protocol`; never edit it by
hand (it is `#[rustfmt::skip]`). `mod.rs` holds the hand-written layer:
`Patch<T>` for clearable fields, `deserialize_required_nullable`,
`deserialize_present` (only nullable types accept a present `null`),
`ObjectDecode` for map-only structs, `WireInt` for safe integers, and
`ConstBool<V>` / `ConstInt<V>` for literals. It also holds
`DecodeError` (its `Display` removes payload values), `IncomingMessage::classify`
and the `request_line` / `reply_line` / `decode_result` helpers.

- Send catalogued requests with `send_request::<methods::X>` and replies with
  `send_reply::<methods::X>` (`app/runtime/client.rs`). Decode results with
  `decode_result::<methods::X>` in the matching `PendingRpcMatch` arm.
- A decode error for a known method or tag is shown as one diagnostic line and
  never converted to `Unknown`. Only an unknown string tag decodes as
  `Unknown`; a missing or mistyped tag is an error. A malformed `client.tool.call` is answered with
  a failure result. A replayed `agent.event` that does not decode is shown as
  one status line naming its event type.
- Open enums whose wire values include `"unknown"` name their fallback `Other`.
- `ServerNotification::params()` / `ServerRequest::params()` re-encode a
  decoded message (used by the fixture tests).
- `tests.rs` replays the shared fixtures in
  `packages/protocol/tests/fixtures/protocol/` and the Steer trace.
