# Desktop Spec Rules

## Product framing

- Specify the desktop app as an agent-centered IDE-lite, not as a generic chat clone.
- Keep `workspace -> session/chat -> supporting panels` as the primary information hierarchy.
- MVP must always remain a strict subset of the final-state specs in this directory.

## Boundaries

- Keep product-level desktop behavior separate from Electrobun implementation details.
- Keep runtime authority centralized in `@codelia/runtime`; desktop UI does not take over sandbox, permissions, or agent logic.
- Prefer existing RPCs before introducing new `workspace.*` or desktop-only protocol expansions.

## Spec style

- Use short sections with explicit `Goals`, `Core behavior`, `Future-facing requirements`, and `Non-goals` when helpful.
- Be concrete about user-visible behavior and cross-panel interactions.
- Mark deferred behavior as future work instead of mixing it into MVP acceptance.
