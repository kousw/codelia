# Desktop Information Architecture

This document defines the stable regions and navigation model for the desktop app.

## 1. Goals

- Make workspace and session switching fast and obvious.
- Preserve chat as the primary focus area.
- Keep files, git, and shell close at hand without overwhelming the main conversation flow.

## 2. Primary layout

### 2.1 Left sidebar

The left sidebar contains navigation objects, in this order:

- global actions (`New workspace`, `Open workspace`, `New session`)
- workspace list
- session list for the selected workspace
- optional secondary entries such as settings/help

The selected workspace controls the center-pane session list and the auxiliary panel context.

### 2.2 Top bar

The top bar shows high-signal state only:

- workspace display name
- path or repo/worktree hint when needed
- current branch or detached-head indicator
- active run state
- current model/reasoning selection
- contextual actions such as refresh, open in editor, or view toggles

### 2.3 Center pane

The center pane is reserved for:

- active session transcript
- run status inline markers
- composer
- inline attachments/context chips
- approval/UI-request flows

It should remain usable even if the auxiliary panel is closed.

### 2.4 Auxiliary panel

The auxiliary panel hosts multiple tabs or sections:

- Files
- Git
- Shell
- optional future tabs such as Context or Diagnostics

Only one primary auxiliary view needs to be visible at a time.

## 3. Navigation rules

- Workspace switch changes the visible session list and supporting repo context.
- Session switch keeps the same workspace but changes the chat transcript, active run state, and session-scoped context.
- Auxiliary panel state should persist per workspace when reasonable.
- Keyboard navigation must support:
  - sidebar focus
  - session switching
  - panel switching
  - composer focus return

## 4. Empty and transitional states

- No workspace selected:
  - show onboarding/open-workspace state
  - disable file/git/shell surfaces
- Workspace selected with no sessions:
  - show empty-state prompt to start a new session
- Runtime disconnected:
  - keep navigation available
  - block execution actions
  - surface reconnect status clearly

## 5. Future-facing requirements

- The layout should accommodate a richer git panel and shell pane without rethinking the top-level structure.
- If multi-agent support is added later, it should extend the session model rather than replace the layout foundation.

## 6. Non-goals

- separate permanent panes for every tool surface
- multiple independent center panes
- multi-window session orchestration
