# Desktop Package Rules

- Keep runtime/protocol as the source of truth for runs, models, MCP, skills, and UI requests.
- Use desktop-local metadata only for desktop-owned organization and lightweight layout concerns such as recent workspaces, session title/archive state, and persisted sidebar width.
- Keep the Electrobun split clear: native/window/menu concerns in `src/bun/`, UI rendering in `src/mainview/`, runtime bridge/storage in `src/server/`.
- Prefer direct relative imports into workspace source packages when Electrobun bundling struggles with workspace package resolution.
- Match existing desktop naming conventions by file role:
  React component files use `PascalCase`, hooks use `useXxx.ts`, and non-component support modules use `kebab-case`.
- Enforce mainview layer boundaries:
  `components/` must not import `state/` or `hooks/` directly;
  `hooks/` must not import `components/`;
  `state/` must not import `components/`, `hooks/`, or `controller/`;
  `controller.ts` and `controller/` must not import `components/` or `hooks/`;
  `commitState` stays inside `state/`, and presentation surfaces must not reference raw `ViewState`.
- Keep hot mainview state updates slice-oriented:
  do not deep-clone the full `ViewState` for streaming events, and preserve unrelated large slice identities.
- Route live runtime events through run/session-keyed live buffers before projecting them into the selected transcript.
- Render transcript tool/reasoning rows as typed React rows, not string-built HTML.
- Keep `src/mainview/index.css` as an ordered import entrypoint and place CSS bodies under `src/mainview/styles/` by surface.
- Runtime client eviction must skip clients with active/awaiting runs or pending RPC requests.
- Tests under `packages/desktop/tests` also use `kebab-case` plus `*.test.ts` / `*.test.tsx`, even when they cover `PascalCase` component files.
