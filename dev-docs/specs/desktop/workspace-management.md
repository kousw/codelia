# Desktop Workspace Management

This document defines how the desktop app manages multiple workspaces and workspace-scoped sessions.

## 1. Goals

- Treat workspaces as a first-class unit of organization.
- Keep sessions grouped under the workspace they belong to.
- Support repository-root and worktree-root workflows cleanly.

## 2. Workspace model

A workspace represents the root context used by the desktop app for:

- session grouping
- git inspection
- shell working directory
- file tree root
- context defaults sent to runtime

A workspace may point to:

- a repository root
- a worktree root
- a non-git directory, with git surfaces disabled

## 3. Core behavior

### 3.1 Workspace list

The app should maintain a persistent list of recently opened workspaces.
Each entry should expose:

- display name
- absolute path
- repo/worktree status
- last opened timestamp
- last active session reference when available

### 3.2 Opening and reopening

The app should support:

- open existing directory as workspace
- reopen recent workspace
- remove broken or stale workspace entries

If a stored workspace path is missing or inaccessible, the entry should be marked invalid rather than silently disappearing.

### 3.3 Workspace-scoped sessions

Each workspace owns its own session list.
The desktop app should not present a single global session stream mixed across unrelated workspaces.

Expected behaviors:

- switching workspace replaces the visible session list
- creating a new session happens within the selected workspace
- reopening a workspace may restore its last active session

### 3.4 Workspace state

The workspace shell should show and refresh:

- current branch/HEAD state
- repo cleanliness summary
- workspace root path
- runtime cwd/workspace root alignment

## 4. Future-facing requirements

- allow pinning/favoriting workspaces
- allow grouping by repository for multiple worktrees
- allow workspace-scoped preferences such as default model or external editor action

## 5. Non-goals

- project boards or issue-tracker views
- multi-repo aggregation as a core requirement
- workspace creation flows that synthesize branches/worktrees automatically

Those can be added later if the product explicitly grows in that direction.
