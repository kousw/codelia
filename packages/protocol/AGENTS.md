# @codelia/protocol

Type definition for the UI protocol used between Core and UI (TUI/desktop).
Provides JSON-RPC 2.0 compatible envelopes and run/agent/ui message types.
Maintains independence from `@codelia/core`.
The cross-boundary common type refers to `@codelia/shared-types` (does not depend on core/runtime implementation type).
Contains model.list / model.set / session.list / session.history (model.list can return details with include_details).
run.start accepts session_id.
Contains `mcp.list` and `supports_mcp_list` capability for MCP status display.
Includes `skills.list` and `supports_skills_list` capabilities for skills catalog retrieval.
Contains `context.inspect` and `supports_context_inspect` capabilities for taking context snapshots.
`context.inspect` can receive `include_skills` and return skills catalog status.
Provide `mcp-protocol.ts` (protocol version constant/compatibility check helper) for MCP transport handshake and share it with runtime/cli.

Reference specifications:
- docs/specs/ui-protocol.md

Build:
- bun run --filter @codelia/protocol build
