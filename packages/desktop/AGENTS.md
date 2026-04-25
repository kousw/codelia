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
- Current GUI architecture review and follow-up risks: `dev-docs/specs/desktop/gui-architecture-review-2026-04-25.md`
- Runtime bridge, inspect, approvals, and context surfaces: `dev-docs/specs/desktop/context-and-runtime.md`
- Electrobun shell responsibilities and limits: `dev-docs/specs/desktop/electrobun-shell.md`
- Visual direction and workbench feel: `dev-docs/specs/desktop/visual-design.md`
- Package-local constraints: `packages/desktop/RULES.md`

## Architecture

- `src/bun/` is the Electrobun shell layer.
  It owns window creation, titlebar/chrome behavior, application menu wiring, BrowserView RPC registration, and child-process ownership for the bundled runtime.
  Standard desktop edit shortcuts such as copy, paste, undo, redo, and select-all should come from native `ApplicationMenu` roles unless there is a product-specific reason to override them.
  Main-window bounds/maximized persistence lives here and is stored in `desktop/window-state.json`, not mixed into runtime/session metadata.
- `src/server/` is the desktop orchestration/runtime-bridge layer.
  It owns workspace loading, session discovery, desktop-local metadata, runtime client lifecycle, and projection of runtime messages into desktop snapshot/stream state.
  Desktop-local metadata currently lives under the Codelia config root at `desktop/desktop.json`, with legacy top-level `desktop.json` migrated there on access.
  Use that file for lightweight desktop-local UI preferences such as persisted sidebar width in addition to recent workspace/session metadata.
- `src/shared/` is the package-local contract layer.
  Put RPC schema, DTOs, transcript projection helpers, and cross-boundary types here. Keep files browser-safe unless they are explicitly bun-only.
- `src/mainview/` is the webview rendering layer.
  It consumes `DesktopSnapshot` and streamed events, renders the session-centric UI, and responds to runtime-driven UI requests.
  Keep mainview-owned UI/app state in `src/mainview/state/` under the Zustand desktop store, not embedded inside React components or redefined inside `controller.ts`.
  For ordinary action/status iconography, use the shared `lucide-react` set from `src/mainview/icons.ts` rather than scattering one-off inline SVGs through the UI.
  Keep the topbar `Cursor/Finder` split-button scoped to opening the currently selected workspace in an external app, while sidebar workspace-add actions should open another workspace and land in a fresh draft/session.
  When a run is active, prefer a dedicated bottom-of-conversation processing indicator over inserting a standalone `Running...` placeholder as an empty assistant turn.
  Do not render low-signal `step_start` / `step_complete` note rows in the normal transcript; keep the transcript focused on prose, tool disclosures, and actionable status.
  Live runtime events should be routed through `ViewState.liveRuns` keyed by `run_id`/`session_id`; do not append stream events directly to the visible transcript unless the run belongs to the selected session.
  Transcript tool/reasoning/note rows should stay typed React rows from `controller/transcript.ts`; do not reintroduce string-built HTML or `dangerouslySetInnerHTML` for timeline rows.
  Keep model, reasoning, and fast-mode controls together in the composer-adjacent metadata row; reasoning is a first-class picker and fast mode is a compact toggle, not a hidden inspect/debug setting.
  Desktop composer command handling lives in `src/mainview/controller/actions/prompt.ts`: `!command` must call runtime `shell.exec` and queue a deferred `<shell_result>` block for the next normal prompt, while `/` commands should map only to desktop-native actions or clearly report unsupported usage.
  Transcript auto-scroll should only follow new content when the user is already within a small bottom buffer of the scroll owner; never yank the viewport when they have scrolled up to inspect older output.
  Keep transcript scroll-follow effects inside a dedicated scroll-region component instead of growing `TranscriptPane` with DOM synchronization logic.
  Keep `src/mainview/index.css` as the ordered style entrypoint only; place mainview CSS bodies under `src/mainview/styles/` by surface and preserve import order when moving selectors so cascade behavior stays stable.
- `src/mainview/controller.ts` is the public application/controller boundary for the desktop webview.
  Keep real controller implementation under `src/mainview/controller/` and use `src/mainview/controller.ts` as a thin facade/export surface.
  It owns Electroview RPC wiring, run/session actions, and transcript projection helpers.
  Do not make it the state owner again; it should read/write through explicit helpers in `src/mainview/state/`.
- `src/mainview/components/` is the presentational React layer.
  Keep components focused on layout and interaction surfaces; they should call exported controller actions instead of importing Electrobun APIs directly.
  Presentation components should receive explicit props rather than raw `ViewState` objects whenever practical.
  Components must not import from `src/mainview/state/` or `src/mainview/hooks/`; wire state in `App`/container hooks and pass explicit props downward.
  Group transcript-specific components under `src/mainview/components/transcript/` once that surface starts growing beyond a single file.
  Split a component once it starts mixing transcript orchestration, DOM synchronization, and render-only leaves in one file; keep assembly panes thin, render leaves isolated, and local motion/helpers in adjacent modules.
  Apply the same rule to the rest of mainview: keep shell sections under a local subdirectory such as `components/shell/`, landing-specific leaves under `components/landing/`, and sidebar-only rows/lists under `components/sidebar/` once those surfaces mix orchestration with render-only markup.
- `src/mainview/hooks/` contains React-only selector/view-adapter hooks over the desktop state layer.
  Prefer feature hooks such as transcript/composer/sidebar/modal selectors over one broad app-shell hook so `App` wires slices instead of passing a raw app-shaped object around.
- `src/mainview/state/` is the shared desktop store layer.
  Keep it independent from React presentation/hook modules; controller may read/write it, hooks may select from it, and components should not import it directly.
  Restrict `commitState` to the state layer itself; controller code should call explicit state action helpers rather than patching store state inline.
  Once actions start growing, split them under `src/mainview/state/actions/` by feature (`runtime`, `workspace`, `session`, `composer`, `modal`, `inspect`, `model`) instead of keeping one long action file.
- `src/mainview/controller/actions/` should mirror the same feature axes as the state action layer where practical.
  Keep RPC-facing orchestration there, and keep `src/mainview/controller/actions.ts` as a thin export barrel.
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
- When preserving TUI parity, inspect the current TUI presentation and interaction details instead of assuming an old terminal baseline; the TUI may already include refined visual/state treatments that desktop should learn from or intentionally adapt.
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
- Workspace-local open actions belong in the top bar rather than the sidebar header.
  Prefer a compact split-button/menu that can execute the current target directly while still allowing Cursor vs Finder/File Manager selection without moving workspace selection itself there.
- Sidebar session rows should not rely on explicit divider bars between every item.
  Prefer compact spacing, active state, and typography to separate rows.
- In the transcript, keep user turns as the only explicit bubble treatment.
  Assistant prose should read as plain copy on the shared white work surface, while reasoning/tool structures may use secondary boxes or expandable detail rows.
- Assistant prose may be rendered through `react-markdown` with `remark-gfm`.
  Keep raw HTML disabled by default; treat syntax highlighting and richer code presentation as a follow-up layer rather than coupling them to the first markdown pass.
- Desktop may project capability-gated structured tool payloads into richer transcript rows.
  The first shipped case is `ui_render`: when desktop advertises `supports_generated_ui`, runtime may expose a desktop-only `ui_render` tool and the transcript should render its typed `generated_ui` payload as a subdued inline panel rather than a generic tool disclosure.
- Keep generated UI node families split by renderer responsibility under `components/generated-ui/` once a family grows beyond a compact branch in `GeneratedUiPanel`.
- The initial `ui_render` catalog is not limited to text/table summaries.
  Desktop should also support compact chart/diagram nodes (for example bounded bar charts, simple flow diagrams, and class-diagram-ish structure maps) as long as they stay within the allow-listed generated UI renderer rather than raw HTML execution.
- Longer-term generated UI work should prefer a validated renderer contract fed by a semantic payload + private mapper workflow.
  Desktop should render the final bounded UI spec and keep mapper scratch iterations out of the normal transcript/session narrative.
- Markdown links may resolve through desktop-aware open handlers.
  External URLs should stay external, while workspace-relative or absolute file links should open through the shell bridge instead of behaving like browser navigation.
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
- Sidebar session rows should preserve title width until secondary actions are actually shown.
  Keep timestamps right-aligned in the idle state, then let hover/focus actions replace that right-edge slot with a subtle local backdrop instead of permanently reserving empty space.
- Keep long thread lists collapsed by default behind an explicit more/less affordance instead of letting the sidebar grow into an unbounded history dump.
- Sidebar width is user-adjustable and should persist as a desktop-local preference rather than resetting on every launch.
- Sidebar collapse is a view-level control exposed from the brand bar, with a center-pane restore button when hidden. Keep collapse state separate from persisted sidebar width unless product behavior explicitly changes.
- Sidebar project rows are not project-switch buttons, but each valid project may expose its own `New Chat` action to create a draft in that workspace.
- Project and sidebar thread rows should stay branch-neutral; show branch/worktree context in the Chat composer area where the user can also switch branches.
- Native chrome matters to desktop quality. On macOS, keep the inset/hidden titlebar treatment and use the topbar as the drag region instead of relying on default framed chrome.
- Keep one clear scroll owner per major region so the app does not degrade into a long-page scroller.

## Editing Guidance

- Edit `src/`, `scripts/build-runtime-bundle.ts`, and package docs/spec references.
- Do not hand-edit `dist/`.
- Do not hand-edit `generated/mainview/` or `generated/runtime/index.js`; regenerate them from source scripts/builds.
- Do not treat `generated/runtime/index.js` as primary source code; rebuild it from the script when runtime bundle behavior changes.
- In `src/mainview`, keep file naming consistent with role:
  React component files use `PascalCase`, hook files use `useXxx.ts`, and non-component helper/state/layout modules use `kebab-case`.
- Keep desktop package tests in `packages/desktop/tests` on `kebab-case` `*.test.ts(x)` names even when they target `PascalCase` component files.
- When changing package behavior in a durable way, update this file if future desktop work needs that context.
- For visual changes in `src/mainview`, verify the running desktop window with Computer Use after building the mainview so spacing, chrome, and composer/sidebar layout are checked against the actual Electrobun surface.
- Run `bun run check:architecture` or `bun run check` after mainview layering changes; it enforces the no-raw-`ViewState` / no-outside-`commitState` rules in addition to Biome import boundaries.

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
