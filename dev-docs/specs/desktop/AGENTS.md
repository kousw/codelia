# Desktop Specs

This directory contains the product-level desktop spec family.

## Scope

- Define the desired desktop product independently from a specific UI toolkit.
- Keep runtime/protocol contracts aligned with `dev-docs/specs/ui-protocol.md` and `packages/protocol`.
- Treat `Electrobun` as the first shell implementation target, without making the product spec depend on it everywhere.

## File map

- `overview.md`: product framing, goals, non-goals, shared assumptions
- `information-architecture.md`: screen regions and navigation model
- `workspace-management.md`: workspace lifecycle and workspace-scoped sessions
- `session-chat.md`: conversation UX and TUI parity target
- `context-and-runtime.md`: runtime connection, UI requests, context, model/MCP/skills surfaces
- `file-tree-viewer.md`: file tree and file preview
- `git-viewer.md`: repo status, diff, and light git actions
- `shell-integration.md`: shell pane behavior and libghostty-first implementation direction
- `electrobun-shell.md`: desktop shell constraints and native integration expectations
- `mvp.md`: strict subset of the above specs for first delivery

## Writing guidance

- Keep product behavior framework-agnostic unless the file is explicitly Electrobun-specific.
- Prefer references to existing runtime/protocol behavior over inventing new wire contracts.
- Record future protocol additions only when desktop UX cannot be expressed with current RPC surfaces.
- Keep multi-agent orchestration out of scope for now unless a later spec explicitly adds it.
