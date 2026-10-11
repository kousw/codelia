# Desktop Specs

This directory contains the product-level desktop spec family.

## Scope

- Define the desired desktop product independently from a specific UI toolkit.
- Keep runtime/protocol contracts aligned with `dev-docs/specs/ui-protocol.md` and `packages/protocol`.
- The new Mac-first native shell uses GPUI Kit; `native-gpui.md` defines its current subset and takes precedence over older Electrobun MVP scope for this shell.

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
- `mvp.md`: original Electrobun subset
- `native-gpui.md`: experimental native shell, current capabilities, limits, architecture and verification

## Writing guidance

- Keep product behavior framework-agnostic unless the file is explicitly Electrobun-specific.
- Prefer references to existing runtime/protocol behavior over inventing new wire contracts.
- Record future protocol additions only when desktop UX cannot be expressed with current RPC surfaces.
- Native GPUI exposes existing runtime tasks/subagents. Keep execution authority in runtime; do not introduce another orchestrator.

- `product-roadmap.md`: proposed native product milestones, competitor documentation baseline, worktree substrate inventory and acceptance gates.

`drafts.md` documents implemented native current composer persistence, its physical namespace, staged Send/Clear and acknowledged-only crash guarantee. Keep roadmap gates partial until native OS and full tool/worktree recovery acceptance is verified.
