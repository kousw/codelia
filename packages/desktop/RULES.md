# Desktop Package Rules

- Keep runtime/protocol as the source of truth for runs, models, MCP, skills, and UI requests.
- Use desktop-local metadata only for workspace/session organization concerns such as recent workspaces, session title, and archived state.
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
- Tests under `packages/desktop/tests` also use `kebab-case` plus `*.test.ts` / `*.test.tsx`, even when they cover `PascalCase` component files.
