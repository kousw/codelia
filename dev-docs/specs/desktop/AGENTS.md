# Desktop Specs (`dev-docs/specs/desktop/`)

Product-level desktop specification family.

- **Product framing**: Specify an agent-centered IDE-lite (`workspace -> session/chat -> supporting panels`), not a generic chat clone. Keep product specs framework-agnostic unless explicitly shell-specific (`gpui-shell.md`); keep `mvp.md` a strict subset of final-state specs.
- **Runtime boundaries**: Keep authority centralized in `@codelia/runtime` (desktop UI never takes over sandbox, permissions, or agent logic). Reuse `dev-docs/specs/ui-protocol.md` / `packages/protocol` RPCs before proposing new wire contracts; keep multi-agent orchestration out of scope unless a later spec adds it.
- **Spec style**: Use short sections (`Goals`, `Core behavior`, `Future-facing requirements`, `Non-goals`) and keep deferred behavior explicitly marked as future work.
