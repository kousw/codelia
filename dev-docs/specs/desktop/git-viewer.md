# Desktop Git Viewer

This document defines the git-oriented surfaces of the desktop app.

## 1. Goals

- Show the state of the current workspace repo clearly.
- Make workspace changes easy to inspect without leaving the app.
- Support a small set of safe git actions that directly help the session workflow.

## 2. Repo status surface

The git viewer should surface:

- current branch or detached HEAD
- upstream/target-branch hint when available
- clean/dirty summary
- staged vs unstaged change counts
- untracked files

If the workspace is not a git repo, the panel should show a clear disabled state.

## 3. Changed files

The git viewer should list changed files with enough structure to scan quickly:

- staged section
- unstaged section
- untracked section when relevant

Users should be able to select a file and view its diff.

## 4. Diff viewer

The diff viewer should support:

- unified diff rendering
- file-by-file switching
- large diff truncation or progressive loading safeguards
- color coding for additions/deletions
- jump from diff to file viewer
- send diff or file-change context to the current session

## 5. Light git actions

The final-state spec includes a small set of direct git actions:

- stage file
- unstage file
- discard file changes with explicit confirmation
- refresh repo state

These actions are included because they directly support reviewing and iterating with the agent.

## 6. Deferred git actions

The following are intentionally deferred:

- commit creation
- stash
- branch create/switch
- rebase/cherry-pick/merge conflict workflows
- PR/review-system integrations

## 7. Protocol direction

If desktop needs direct diff reads independent of a run, the preferred addition is:

- `workspace.diff`

The protocol should return explicit truncation rather than silently dropping large patches.

## 8. Non-goals

- becoming a full graphical git client
- hiding destructive actions behind ambiguous UI
