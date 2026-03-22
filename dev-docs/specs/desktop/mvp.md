# Desktop MVP

This document defines the first delivery as a strict subset of the final-state desktop specs.

## 1. MVP goals

- Validate the desktop product shape with minimal moving parts.
- Keep the first release simple while preserving the long-term architecture.
- Deliver a credible workspace-scoped chat client before expanding side surfaces.

## 2. In scope

### 2.1 App shell

- single-window shell
- left sidebar with workspace list and session list
- center pane with active session transcript and composer
- minimal top-bar state for workspace, branch hint, run state, and model

### 2.2 Workspace management

- open workspace
- reopen recent workspace
- workspace-scoped session lists
- restore last active session when practical

### 2.3 Session chat

- create/resume/rename/archive/delete session
- `run.start`
- `run.cancel`
- `agent.event`
- `run.status`
- `run.context`
- `ui.confirm.request`
- `ui.prompt.request`
- `ui.pick.request`
- `session.list`
- `session.history`
- `model.list`
- `model.set`
- `mcp.list`
- `skills.list`
- `context.inspect`

### 2.4 Light supporting surfaces

- simple file tree and file preview are optional-but-desirable if they can be added without protocol expansion
- git viewer and shell pane are not required for MVP

## 3. Out of scope for MVP

- multi-agent orchestration
- embedded interactive shell
- git diff viewer and git write actions
- direct workspace protocol expansion (`workspace.*`)
- heavy diagnostics UI
- updater/tray/deep-link/global-shortcut features

## 4. MVP acceptance

- A user can open a workspace, create or resume a session, and have a full agent conversation without using TUI.
- Runtime-driven confirm/prompt/pick interactions are fully usable on desktop.
- Workspace switching keeps sessions grouped correctly.
- Desktop execution semantics stay aligned with current runtime/TUI behavior.

## 5. Post-MVP priority order

After MVP, preferred expansion order is:

1. file tree + file viewer
2. git viewer with diff and light actions
3. shell pane
4. richer native shell integration
