# Desktop Package

## Role

- `packages/desktop` is the first desktop shell for Codelia, implemented with Electrobun.
- Treat this package as the desktop shell plus desktop-specific orchestration layer, not as a separate agent runtime.
- The desktop product is an agent-centered, session-centric IDE-lite: chat stays primary, and workspace/file/git/shell surfaces exist to support the active session.
- Keep desktop behavior aligned with shared runtime/protocol and TUI execution semantics unless a desktop-only divergence is explicitly specified.

## Read First

- Product direction and spec map: `dev-docs/specs/desktop/overview.md`
- MVP boundary: `dev-docs/specs/desktop/mvp.md`
- UI/state layering and transcript rules: `dev-docs/specs/desktop/ui-architecture.md`
- Runtime bridge, inspect, approvals, and context surfaces: `dev-docs/specs/desktop/context-and-runtime.md`
- Electrobun shell responsibilities and limits: `dev-docs/specs/desktop/electrobun-shell.md`
- Visual direction and workbench feel: `dev-docs/specs/desktop/visual-design.md`
- Package-local constraints: `packages/desktop/RULES.md`

## Architecture

- `src/bun/` is the Electrobun shell layer.
  It owns window creation, titlebar/chrome behavior, application menu wiring, BrowserView RPC registration, and child-process ownership for the bundled runtime.
- `src/server/` is the desktop orchestration/runtime-bridge layer.
  It owns workspace loading, session discovery, desktop-local metadata, runtime client lifecycle, and projection of runtime messages into desktop snapshot/stream state.
- `src/shared/` is the package-local contract layer.
  Put RPC schema, DTOs, transcript projection helpers, and cross-boundary types here. Keep files browser-safe unless they are explicitly bun-only.
- `src/mainview/` is the webview rendering layer.
  It consumes `DesktopSnapshot` and streamed events, renders the session-centric UI, and responds to runtime-driven UI requests.
- `src/mainview/controller.ts` is the application/controller boundary for the desktop webview.
  It owns Electroview RPC wiring, immutable store updates, run/session actions, and transcript projection helpers.
- `src/mainview/components/` is the presentational React layer.
  Keep components focused on layout and interaction surfaces; they should call exported controller actions instead of importing Electrobun APIs directly.
- `src/mainview/hooks/` contains React-only adapters such as `useSyncExternalStore` bindings over the controller store.
- `generated/mainview/` is the Vite build output copied into Electrobun `views://mainview`.
- `generated/runtime/index.js` is the bundled runtime artifact consumed by the Electrobun shell.
- `scripts/build-runtime-bundle.ts` is the source for regenerating that runtime bundle.
- `scripts/prebuild.ts` stages both bundled runtime output and Vite mainview assets before Electrobun build packaging.
- `dist/` is build output, not the editing surface.

## Source Of Truth

- Runtime/protocol is authoritative for run lifecycle, approvals, UI requests, model availability, MCP/skills inspection, and shared session history.
- Desktop-local storage is only for desktop-owned organization state such as recent workspaces and local session metadata like title/archive.
- Session discovery should come from shared session storage filtered by workspace root or workdir, not from desktop-local metadata.
- Treat `session_id` and `run_id` as separate identities. Session switching must not redefine run ownership.
- Desktop may mirror runtime state for presentation, but it must not become the source of truth for execution semantics.

## Working Structure

- Current implementation is intentionally split into shell, orchestration, shared contract, and webview layers. Keep that split clear instead of letting view code absorb shell/runtime concerns.
- `src/mainview/` is a React + Vite client.
  Keep the dependency flow one-way: `components/` and `hooks/` may depend on `controller.ts`, but `controller.ts` must not depend on React components.
- Treat `controller.ts` as the only place that should know about Electroview RPC request/message wiring.
  If a component needs new behavior, expose it through a controller action instead of reaching into Electrobun APIs from the view.
- Keep transcript projection faithful to runtime event order: preserve assistant/tool sequencing, pair `tool_call` and `tool_result` by `tool_call_id`, and keep verbose payloads inspectable even when collapsed by default.
- Keep auxiliary surfaces supportive. The active session remains the primary workflow; inspect or future file/git/shell surfaces should feed context back into chat rather than replace it.
- Prefer direct relative imports into workspace source packages when Electrobun bundling is unreliable with workspace package resolution.

## UI And Product Direction

- Build toward a calm, dense, workbench-oriented desktop UI rather than decorative marketing-style layouts.
- Treat `dev-docs/specs/desktop/visual-design.md` as the source of truth when local styling experiments drift.
- Prefer neutral, mostly monochrome working surfaces; amber should remain a precise accent for selection, focus, and primary action instead of tinting large areas.
- `src/mainview/index.css` should use Codelia amber as a restrained accent, not as a page-wide fill or dominant background.
- The main empty state should feel composed and useful, with a clear primary action plus supporting context, not a sparse placeholder.
- Keep UI parts dense and utility-first.
  Top bars should stay compact, transcript surfaces should not become oversized framed cards, and list rows should read as list items before they read as panels.
- In the top bar, prefer direct workspace identity over redundant category labels.
  If the region is already obviously the workspace header, show the workspace name/path without an extra `Workspace` kicker.
- Keep the workspace identity strip to a single compact line where practical.
  Avoid stacking name and path into separate rows unless the viewport is genuinely constrained.
- In that single-line workspace strip, preserve the workspace name first and let the path truncate second.
  The primary identity should not collapse before the secondary path text.
- Do not add artificial left inset to the main-pane top bar on macOS just to compensate for window controls.
  The workspace title should align with the main content column, not with an imagined traffic-light offset.
- Keep the top bar narrow in responsibility.
  It should primarily carry workspace identity plus lightweight utility state such as runtime connectivity or inspect toggle, not every session control.
- Sidebar session rows should not rely on explicit divider bars between every item.
  Prefer compact spacing, active state, and typography to separate rows.
- In the transcript, keep user turns as the only explicit bubble treatment.
  Assistant prose should read as plain copy on the shared white work surface, while reasoning/tool structures may use secondary boxes or expandable detail rows.
- For reasoning/tool expandable rows, prefer flat disclosure styling over framed cards.
  The expand affordance should stay obvious through chevrons, dividers, and spacing even when the outer box is removed.
- In those expandable rows, prefer a left-edge state marker over redundant textual status chips such as `Done`.
  Keep the row aligned even when the explicit state word is omitted.
- Do not hard-code a wide label column for transcript disclosure rows.
  Labels like `Shell` or `Read` should size to content so the main summary text does not start with a large empty gap.
- Keep transcript disclosure chevrons near the summary terminus instead of pinning them to the far right edge.
  The row should read as compact inline metadata, not as a full-width accordion bar.
- Use one shared motion profile for disclosure and utility transitions.
  Keep chevron rotation, panel reveal, and transcript disclosure motion short and direct with the same timing tokens; avoid springy or decorative easing.
- Consecutive `Read` tool calls may be grouped into one parent disclosure row with nested per-file items.
  Preserve access to each file's detailed result instead of flattening the group into an unreadable single blob.
- Treat branch and model selection as composer-adjacent controls rather than top-bar chrome.
  Put them below the chat input/action row so they read as local composition context instead of global header furniture.
- Session row actions should not sit as large overlaid pills on top of content.
  Prefer compact secondary actions or menus that do not consume the primary row layout.
- In the sidebar, avoid stacked action rows under list items.
  Secondary actions should appear inline without increasing row height or creating empty bands between items.
- Native chrome matters to desktop quality. On macOS, keep the inset/hidden titlebar treatment and use the topbar as the drag region instead of relying on default framed chrome.
- Keep one clear scroll owner per major region so the app does not degrade into a long-page scroller.

## Editing Guidance

- Edit `src/`, `scripts/build-runtime-bundle.ts`, and package docs/spec references.
- Do not hand-edit `dist/`.
- Do not hand-edit `generated/mainview/` or `generated/runtime/index.js`; regenerate them from source scripts/builds.
- Do not treat `generated/runtime/index.js` as primary source code; rebuild it from the script when runtime bundle behavior changes.
- When changing package behavior in a durable way, update this file if future desktop work needs that context.

## Skill Usage

- For layout, styling, and React view composition work in `src/mainview/components/`, use `frontend-skill` plus `react-best-practices`.
- For controller/store changes in `src/mainview/controller.ts` and `src/mainview/hooks/`, keep React concerns out of the controller boundary and use hooks only as adapters.
- For `src/bun/` and native desktop behaviors such as windows, menus, dialogs, tray, packaging, or debugging, prefer the relevant `electrobun-*` skill.
- For cross-cutting desktop doc/context maintenance, use `agent-context-ops`.
- If a task spans React UI, controller/store code, and Electrobun shell concerns, combine the relevant skills by file/responsibility instead of treating the whole package as a generic web app.

## Commands

- `bun run dev` prepares runtime/mainview assets, then runs Vite watch build and Electrobun watch mode together.
- `bun run dev:mainview` runs the Vite watch build for `src/mainview/`.
- `bun run dev:shell` runs Electrobun watch mode without re-staging assets.
- `bun run build` builds the desktop package.
- `bun run build:mainview` rebuilds the Vite client into `generated/mainview/`.
- `bun run build:runtime` rebuilds the bundled runtime entry consumed from `generated/runtime/index.js`.
- `bun run prepare:assets` rebuilds both mainview and runtime generated artifacts.
- `bun run typecheck` runs the package TypeScript check.
- `bun run fmt` formats `src`, `scripts`, `electrobun.config.ts`, and `vite.config.ts`.
- `bun run check` runs Biome checks for this package.
