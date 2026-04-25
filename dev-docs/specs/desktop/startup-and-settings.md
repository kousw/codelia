# Desktop Startup And Settings

This document defines app launch behavior, restore behavior, and settings scope for the desktop client.

## 1. Goals

- Make desktop startup predictable and fast enough to feel native.
- Restore useful working context without surprising the user.
- Keep settings understandable across app-wide, workspace-scoped, and session-scoped concerns.
- Stay aligned with runtime/TUI behavior where execution semantics are shared.

## 2. Startup lifecycle

Desktop startup has four product-visible phases:

1. Shell boot
   - create the main window
   - restore window size/position/state when safe
   - render a lightweight shell immediately

2. Workspace/session restore
   - restore the last selected workspace when it still exists
   - restore the last selected session for that workspace when available
   - if the workspace is missing, show an explicit invalid/reconnect state rather than silently dropping it

3. Runtime initialization
   - start or reconnect to the local runtime child process
   - surface connected/offline/initializing state clearly in the app chrome
   - keep navigation usable even if execution is temporarily unavailable

4. Surface hydration
   - load workspace list
   - load workspace-scoped session list
   - hydrate transcript/history for the selected session
   - defer secondary surfaces such as inspect until requested

## 3. Launch behavior

### 3.1 First launch

When there is no prior desktop state:

- show a clean onboarding/open-workspace state
- do not force inspect, file tree, or git panes open
- keep chat disabled until a workspace is selected

### 3.2 Subsequent launch

When desktop state exists:

- reopen the most recent valid workspace by default
- restore the last active session for that workspace when possible
- restore panel layout and lightweight UI preferences only if they do not hide the main task flow

### 3.3 Error handling

Desktop must distinguish:

- shell startup failure
- runtime startup failure
- workspace access failure
- session hydration failure

Each class should surface a recovery path:

- retry
- reopen workspace
- start a fresh session
- inspect error details when necessary

## 4. Restore rules

Restore behavior should be conservative:

- unsent composer draft restores per session when practical
- live runs continue in the background when the app/client switches sessions
- returning to a running session should show resumed live state rather than pretending the run stopped
- destructive restore side effects should never occur automatically

## 5. Settings model

Settings are grouped into three scopes.

### 5.1 App-wide settings

- theme mode when desktop later supports multiple themes
- window behavior
- preferred external editor action
- telemetry/diagnostics visibility preferences
- global keyboard shortcut preferences where applicable

### 5.2 Workspace settings

- default model for the workspace
- default reasoning level when supported
- hidden file visibility for file tree
- preferred auxiliary panel defaults such as terminal/file tree tab

### 5.3 Session-local state

- draft composer text
- transcript folding/open state when practical
- attached context chips before send
- current file/diff/output selections being staged into the next prompt

Session-local state may be ephemeral and does not need the same durability guarantees as app/workspace settings.

## 6. Storage expectations

Desktop should keep a strict split between:

- shared session/runtime data in the common Codelia storage
- desktop-only UI metadata such as recent workspaces, archived state, titles, and window/layout preferences
- Desktop window bounds/maximized state may live in a dedicated desktop shell file separate from recents/session metadata when that reduces write-frequency coupling.

This split is important so terminal/TUI-created sessions can later become discoverable without moving their execution authority into the desktop client.

## 7. Settings surface UX

Settings should not dominate the MVP shell.

Preferred direction:

- lightweight settings dialog or sheet
- workspace settings inline near the relevant workspace/model controls
- avoid a heavyweight multi-page preferences app unless the surface genuinely grows

## 8. TUI parity baseline

Startup/settings may differ in layout from TUI, but they must not change:

- where session state lives
- how runtime connection status is interpreted
- how model selection affects execution
- how resumed sessions relate to the same runtime/session store semantics

## 9. Non-goals

- account/profile management as a desktop-specific concept
- independent desktop-only execution settings that diverge from runtime policy
- restoring every transient panel scroll position as a baseline requirement
