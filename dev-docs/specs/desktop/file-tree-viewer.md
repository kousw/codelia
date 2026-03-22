# Desktop File Tree And Viewer

This document defines the file navigation and file preview surfaces for the desktop app.

## 1. Goals

- Let users inspect workspace files without leaving the desktop app.
- Make it easy to send file-level context into the current session.
- Stay lightweight enough to complement an external IDE instead of replacing it.

## 2. File tree

The file tree should:

- root at the selected workspace
- lazy-load directories
- handle large trees without freezing the UI
- indicate files vs directories clearly
- allow hidden-file visibility toggle
- reflect changed/interesting files when git data is available

The file tree is a navigation surface first, not a full project explorer replacement.

## 3. File viewer

The file viewer should support:

- text preview for common source/config/docs files
- large-file safeguards
- basic binary/file-type fallback states
- image preview where straightforward

The viewer is read-first.
Editing is not required by this spec.

## 4. Session integration

From the file tree/viewer, users should be able to:

- mark a file as the current active file
- send file path/context to the current session
- send a current selection or highlighted text to the current session
- jump from git diff entries into the file viewer

These actions should flow through the same session/context model as chat attachments.

## 5. Future-facing requirements

- tabs or recent-file history
- richer syntax highlighting
- split preview with diff/file synchronization
- folder-to-chat attachment flow

## 6. Protocol direction

If desktop needs direct workspace reads independent of a run, the preferred additions are:

- `workspace.tree`
- `workspace.read`

Any such addition must remain sandbox-bounded and explicitly size-limited.

## 7. Non-goals

- full editor replacement
- arbitrary write/edit operations from the file tree surface
- language-server or code-intelligence features as a baseline requirement
