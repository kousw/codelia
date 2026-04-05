# Desktop Package Rules

- Keep runtime/protocol as the source of truth for runs, models, MCP, skills, and UI requests.
- Use desktop-local metadata only for workspace/session organization concerns such as recent workspaces, session title, and archived state.
- Keep the Electrobun split clear: native/window/menu concerns in `src/bun/`, UI rendering in `src/mainview/`, runtime bridge/storage in `src/server/`.
- Prefer direct relative imports into workspace source packages when Electrobun bundling struggles with workspace package resolution.
