# Desktop Client (GPUI) Spec

This document defines implementation strategies for adding Desktop clients separately from TUI.
The premise is to unify the execution engine to `@codelia/runtime` and increase only the UI.

## 1. Purpose

- Make the same runtime/protocol available from both TUI and Desktop
- Add the necessary functions (file tree, diff viewer) in GUI step by step
- Maintain a configuration where the domain implementation does not diverge due to UI differences

## 2. Current situation (2026-02-07)

Implemented:
- `@codelia/runtime` acts as a stdio JSON-RPC server
- `@codelia/protocol` has `initialize/run/session/model/ui.*` defined
- `crates/tui` spawns a runtime and executes a conversation using the UI protocol.

Not implemented:
- GPUI client body of `crates/desktop`
- Dedicated RPC for file tree/diff viewer

## 3. Design principles

1. Centralized execution boundaries:
`core/tools/sandbox/permissions` is handled only by runtime.

2. Standardization of wire contract:
Use `@codelia/protocol` even in Desktop-only communication to avoid leaking runtime-specific types to the UI.

3. Limitation of UI Responsibilities:
GPUI clients concentrate on drawing, input, and operation states and do not have agent behavior.

## 4. Recommended configuration

```text
crates/
  desktop/                  # GPUI app (Rust)
packages/
protocol/ # common wire schema
runtime/ # execution engine
  shared-types/             # cross-boundary stable types
```

supplement:
- `crates/desktop` directly spawns and attaches a runtime child process.
- The screen will be completed with GPUI, and WebView/front end will not be separated.

## 5. Communication model

```text
Desktop (GPUI, Rust)
  -> (stdio NDJSON JSON-RPC)
@codelia/runtime
  -> (notifications)
Desktop (GPUI)
```

Requirements:
- Runtime `stdout` is dedicated to JSON-RPC, logs are separated to `stderr`
- Manage request id on UI side and correlate response/notification
- The client's RPC layer transparently transfers protocol messages and has no business logic.

## 6. Implementation phase

### Phase 1: Chat MVP (TUI equivalent)

function:
- initialize/run.start/run.cancel
- agent.event/run.status/run.context display
- resume via session.list/session.history
- model.list/model.set
- mcp.list (status display equivalent to `/mcp`)
- ui.confirm.request / ui.prompt.request / ui.pick.request

Acceptance conditions:
- Same input shows same runtime response as TUI
- confirm/prompt/pick can be completed on Desktop

### Phase 2: Workspace Explorer (file tree)

function:
- Workspace tree view (lazy load)
- Content preview when selecting files
- Reflect active file / selection in `ui.context.update`

Acceptance conditions:
- Can be enumerated/referenced only in sandbox
- UI doesn't freeze even with large directories

### Phase 3: Diff Viewer

function:
- Displaying the editing result diff (unified only first)
- Diff switching for each changed file
- `edit` Integrated display of tool result diff and workspace difference

Acceptance conditions:
- Addition/deletion of changed lines can be read by color coding
- Large diffs can be omitted and continued operation

## 7. Protocol expansion proposal (Phase 2/3)

Desktop's file tree/diff viewer requires inquiries independent of agent execution, so
Add `workspace.*` type RPC.

candidate:
- `workspace.tree`
- `workspace.read`
- `workspace.diff`

Example type:

```ts
export type WorkspaceTreeParams = {
  path?: string;
  depth?: number;
  include_hidden?: boolean;
};

export type WorkspaceTreeResult = {
  entries: Array<{
    path: string;
    name: string;
    kind: "file" | "dir";
    size?: number;
    mtime_ms?: number;
  }>;
};

export type WorkspaceDiffParams = {
  path?: string;
  context?: number;
};

export type WorkspaceDiffResult = {
  patch: string;
  truncated?: boolean;
};
```

supplement:
- Reuse existing `read` / `edit` tool implementations (sandbox, diff utility)
- Place the type in `@codelia/protocol` and implement handler in runtime

## 8. Security and Restrictions

- Verify everything under sandbox root
- Prevent path traversal / symlink entity resolution even with `workspace.*`
- Set limits (e.g. tree count, read bytes, diff bytes)
- If the limit is exceeded, return `truncated` or an explicit error (do not silent drop)

## 9. Non-targets (not covered in this spec)

- Multi-window synchronization
- Real-time collaborative editing
- Heavy code highlighting engine (tree-sitter etc.)

These are managed with `docs/specs/backlog.md`.
