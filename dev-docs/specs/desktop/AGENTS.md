# Desktop Specs

This directory contains the product-level desktop spec family.

## Scope

- Define the desired desktop product independently from a specific UI toolkit.
- Keep runtime/protocol contracts aligned with `dev-docs/specs/ui-protocol.md` and `packages/protocol`.
- Treat `Electrobun` as the first shell implementation target, without making the product spec depend on it everywhere.

## File map

- `overview.md`: product framing, goals, non-goals, shared assumptions
- `startup-and-settings.md`: launch lifecycle, restore behavior, and settings scope
- `information-architecture.md`: screen regions and navigation model
- `visual-design.md`: visual system, density, typography, and color direction
- `ui-architecture.md`: state/layer boundaries, session/run routing, and scroll ownership
- `tui-parity-baseline.md`: required behavioral baseline borrowed from the TUI client
- `workspace-management.md`: workspace lifecycle and workspace-scoped sessions
- `session-chat.md`: conversation UX and TUI parity target
- `context-and-runtime.md`: runtime connection, UI requests, context, model/MCP/skills surfaces
- `model-settings.md`: model and reasoning controls in desktop UI
- `file-tree-viewer.md`: file tree and file preview
- `git-viewer.md`: repo status, diff, and light git actions
- `shell-integration.md`: shell pane behavior and libghostty-first implementation direction
- `inline-shell-execution.md`: transcript-facing shell execution behavior distinct from built-in terminal
- `electrobun-shell.md`: desktop shell constraints and native integration expectations
- `mvp.md`: strict subset of the above specs for first delivery

## Writing guidance

- Keep product behavior framework-agnostic unless the file is explicitly Electrobun-specific.
- Prefer references to existing runtime/protocol behavior over inventing new wire contracts.
- Record future protocol additions only when desktop UX cannot be expressed with current RPC surfaces.
- Keep multi-agent orchestration out of scope for now unless a later spec explicitly adds it.
- When a desktop spec touches shared run/session semantics, check it against the TUI behavior baseline before treating it as settled.
