# @codelia/protocol

Core-independent UI/runtime JSON-RPC 2.0 wire catalog (`src/catalog.ts` -> `ProtocolMethod`). Depends on `@codelia/shared-types` only.

## Codegen & Compatibility (`dev-docs/specs/protocol-codegen.md`)

- Define/update wire schemas (`<Type>Schema` + `z.infer` export) and capability gates in `src/catalog.ts` (using `packages/shared-types/src/wire.ts` helpers). Run `bun run generate:protocol` and commit `schema/protocol.schema.json`, `schema/methods.md`, `crates/protocol/src/generated.rs`, and `tests/fixtures/protocol/*.jsonl`.
- Keep `skills.ts` types aligned with `@codelia/shared-types` (enforced by tests).
- Use single-value `z.enum` instead of `z.literal` for extensible string sets (literals decode strictly in Rust).
- Put structured error payloads in catalog `errorData` / shared `protocolErrorData`; clients branch on `reason` while error code is advisory.
- `mcp-protocol.ts` centralizes MCP protocol version checks shared with runtime and CLI.

## Wire Semantics & Fixtures

- `session.history` marks replayed `agent.event` notifications with `meta.replayed: true`; provisional `text.delta`/`reasoning.delta` (`supports_text_delta`) are never replayed.
- `supports_scoped_logout` gates `auth.logout.provider` (never reinterpret scoped logout as clearing all providers); `supports_model_ultrafast` gates `"ultrafast"`; `run.status.error` carries safe `RunErrorInfo`; `initialize.local_host` startup Auto approve status mirrors to `initialize.tui`; `image.artifact.get` transfers bounded original image bytes (PNG or JPEG data URL with original MIME, never runtime-host filesystem paths).
- Refresh shared Steer trace fixture after intentional wire changes: `CODELIA_TEST_UPDATE_STEER_FIXTURE=1 bun test packages/runtime/tests/run-steer.test.ts -t "shared Steer notification"`, then replay via `cargo test --locked --manifest-path crates/protocol/Cargo.toml shared_steer_trace`.
- Build: `bun run --filter @codelia/protocol build`.
