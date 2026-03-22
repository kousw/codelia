# Electrobun Desktop Shell

This document captures implementation-specific assumptions for an Electrobun-based first desktop shell.

It complements the product specs in this directory and should not redefine them.

## 1. Goals

- Make Electrobun the first practical desktop shell without locking the product to it permanently.
- Keep most product behavior in web UI + runtime/protocol layers.
- Reserve Electrobun-specific concerns for app shell, native integration, and packaging.

## 2. Responsibilities of the Electrobun shell

The Electrobun layer is responsible for:

- native window lifecycle
- application menu
- file/folder open dialogs
- clipboard bridge as needed
- notifications where supported
- child-process ownership for runtime
- packaging/distribution/update plumbing

The Electrobun shell is not responsible for:

- agent logic
- sandbox policy
- protocol semantics
- business rules for sessions/workspaces/files/git

## 3. Native integrations expected in final state

- native single-window app shell
- open workspace dialog
- copy/paste bridge
- basic menu items for common actions
- open current workspace in external editor
- open current file in external editor when context allows

The following are desirable but not required for the first product iteration:

- updater
- tray
- deep link
- global shortcuts

## 4. Constraints

- Product specs should avoid assuming Chromium-only features.
- The web UI should remain compatible with Electrobun's supported browser/runtime environment.
- Shell embedding details may evolve; the product spec should not depend on a specific terminal API shape.

## 5. Relationship to future desktop shells

If a future GPUI or other native shell is pursued, it should be able to reuse:

- runtime/protocol assumptions
- product-level workspace/session/file/git/shell specs
- MVP boundaries

Only shell-implementation details should need to change materially.
