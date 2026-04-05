# Desktop Product Overview

This spec family defines the desired desktop product for Codelia.
It is intentionally product-first and UI-framework-agnostic.

The desktop app is an **agent-centered IDE-lite**:

- conversation with the coding agent remains the primary workflow
- workspace state, files, git, and shell are first-class supporting surfaces
- runtime/protocol stay shared with TUI so execution behavior does not diverge by client
- the visual direction should be calm, dense, and workbench-oriented rather than decorative

This spec family should be read with a simple rule:

- TUI is the baseline for shared execution behavior
- desktop is free to add richer surfaces and layout as long as it does not silently drop that behavior

## 1. Goals

- Provide a desktop client that feels native to coding work, not just a wrapped chat window.
- Keep `@codelia/runtime` and `@codelia/protocol` as the execution/control plane.
- Support multiple workspaces, each with its own session history and development context.
- Make file, git, and shell state easy to inspect and send back into the conversation.
- Define the final-state product now so MVP can later be chosen as a strict subset.

## 2. Product shape

The app uses a single-window layout with four stable regions:

- left sidebar: workspace list and session list
- center pane: current session chat and composer
- auxiliary panel: files, git, shell, inspect, and related context views
- top bar: workspace identity, branch/run state, model, and app-level actions

The center pane owns the primary task flow.
The auxiliary panel exists to support the current session, not to replace a full IDE.
It should be optional and hideable rather than permanently consuming space by default.

## 3. Shared design principles

1. Runtime authority remains centralized.
   - sandbox, permissions, model execution, tool execution, and session state belong to runtime
   - desktop UI displays and requests, but does not reimplement agent logic

2. Desktop should stay session-centric.
   - every major supporting action should have a clear path back into the active session
   - files, diffs, and shell output should be attachable as context

3. Workspace state is a first-class product concept.
   - a workspace is the unit of repo context, session grouping, git state, and shell working directory

4. Final-state specs should not be artificially constrained by the MVP.
   - the desktop product should be designed for its intended long-term shape first

## 4. Shared assumptions

- Multi-agent orchestration is out of scope for this version of the desktop product.
- The initial desktop implementation target is Electrobun, but the product spec should remain reusable by future shells.
- A workspace may correspond to a repository root or a worktree root.
- Session execution semantics should remain aligned with TUI unless a desktop-only UX reason is documented.

## 5. Non-goals

- full IDE replacement with heavy editing/code-intelligence features
- real-time collaborative editing
- multi-window synchronization
- browser extension/platform ecosystems
- full Git client behavior

## 6. Spec family

The desktop spec family is intentionally split by product surface:

- startup and restore behavior
- design/language and UI architecture
- workspace/session organization
- chat/runtime/model workflow
- auxiliary surfaces such as files, git, terminal, and inline shell execution

TUI parity for shared behavior is tracked explicitly so desktop work does not lose capabilities that already exist in the terminal client.

## 7. Related specs

- `information-architecture.md`
- `startup-and-settings.md`
- `visual-design.md`
- `ui-architecture.md`
- `tui-parity-baseline.md`
- `workspace-management.md`
- `session-chat.md`
- `context-and-runtime.md`
- `model-settings.md`
- `file-tree-viewer.md`
- `git-viewer.md`
- `shell-integration.md`
- `inline-shell-execution.md`
- `generative-ui.md`
- `electrobun-shell.md`
- `mvp.md`
