# Desktop TUI Parity Baseline

This document defines the minimum behavioral baseline the desktop client should preserve from the TUI.

The goal is not pixel parity.
The goal is preventing desktop product work from accidentally dropping essential agent-client capabilities that already exist in TUI.

## 1. Why this document exists

Desktop has richer layout ambitions than TUI.
That is good, but it creates a risk:

- layout/spec work can focus on panes and visuals
- while important run/session behaviors quietly regress or disappear

This file is the checklist that every major desktop surface should be measured against.

## 2. Core parity areas

### 2.1 Session lifecycle

Desktop should preserve:

- create new session
- resume session
- load prior transcript/history
- clear distinction between workspace grouping and session identity

### 2.2 Run lifecycle

Desktop should preserve:

- one send -> one run
- live `run.status` visibility
- cancel behavior
- completed/cancelled/error terminal states
- background continuation when the user changes visible session

### 2.3 Transcript semantics

Desktop should preserve:

- event order
- assistant text interleaving with tool activity where applicable
- structured approval/request visibility
- readable compaction of verbose tool output
- inspectability of reasoning/progress/tool result details

### 2.4 Runtime-driven UI requests

Desktop must support:

- confirm
- prompt
- pick

and must block/resume runs in the same way TUI/runtime expect.

### 2.5 Model/runtime awareness

Desktop should preserve:

- model list / selection
- reasoning selection when supported
- runtime connected/offline visibility
- context/MCP/skills discoverability

### 2.6 Shell/task behavior

Desktop should preserve:

- shell execution visibility
- running/completed/error distinctions
- compact summaries instead of raw output spam
- access to detailed output on demand

## 3. Expected desktop differences

Desktop is allowed to differ from TUI in:

- screen layout
- side panels and auxiliary views
- use of mouse-driven affordances
- richer file/git/terminal supporting surfaces
- progressive disclosure through drawers/details/panels

Desktop is not allowed to differ silently in:

- where session truth lives
- what a run means
- what approval/cancel/model actions do
- how tool/event ordering is interpreted

## 4. Design review questions

When adding a desktop feature or rewriting an existing one, ask:

1. Which TUI behavior is this replacing or complementing?
2. Does the desktop version still expose the same underlying execution truth?
3. Could a user lose visibility into a run/session/tool lifecycle that TUI already handles?
4. Is the desktop surface making a supporting function look more primary than chat without product intent?

## 5. Spec-family usage

Each major desktop spec should be read with this baseline in mind:

- `session-chat.md`
- `workspace-management.md`
- `context-and-runtime.md`
- `shell-integration.md`
- `inline-shell-execution.md`
- `model-settings.md`
- `file-tree-viewer.md`
- `git-viewer.md`

## 6. Non-goals

- forcing desktop to mimic TUI interaction patterns mechanically
- blocking all desktop-specific UX improvements until exact TUI parity exists
