# TUI Bang Shell Mode Spec (`!`)

Status: `Planned` (2026-02-15)

This document defines an immediate shell execution path in TUI using `!` prefix
input, with deferred result injection into the next user message.

---

## 0. Motivation

For quick environment checks (`git status`, `ls`, `rg`), users want a direct
shell path that does not trigger model reasoning immediately.

Requirements from UX:

1. `!` executes shell command immediately.
2. Execution result is not sent to model at execution time.
3. Result is injected as tagged context in the next user message.
4. Large output must be bounded, while keeping debug value (head/tail + cache).

---

## 1. Scope / Non-scope

### In scope

- `!` prefix parsing and direct command execution route.
- Runtime execution contract for bang commands.
- Deferred result injection format (`<shell_result>...</shell_result>`).
- Output truncation + cache reference policy.

### Out of scope (phase 1)

- Interactive shell session mode (REPL/PTY attach).
- Command auto-completion/history search for `!` command body.
- Multi-command scripting UX beyond a single submitted line.

---

## 2. UX Contract

### 2.1 Input rule

If trimmed composer input starts with `!`, treat it as bang command.

- example: `!git status`
- command text = original input minus first `!`, then trim

Validation:

- empty command -> show status error (`bang command is empty`), do not run.

### 2.2 Execution behavior

- Bang command is executed immediately via runtime.
- No `run.start` is sent for this action.
- TUI logs a concise status line (`bang exec started`, `bang exec done` with exit code).

### 2.3 Deferred injection

Execution results are queued locally and injected only when the user sends the
next normal message.

- If user executes multiple bang commands, preserve order.
- If message send fails, keep queued results for retry.

---

## 3. Runtime Route (Separated from Agent `bash` Tool)

Bang execution must use a dedicated runtime path, not the agent tool-call path.

Rationale:

1. Explicitly mark user-originated direct execution (`origin = ui_bang`).
2. Keep model tool-call permissions and bang behavior independent.
3. Avoid accidental exposure of bang-only behavior to model tool set.

### 3.1 Protocol method (planned)

Add UI -> Runtime request:

- `shell.exec`

Params proposal:

```ts
export type ShellExecParams = {
  command: string;
  timeout_seconds?: number; // default 120, max 300
  cwd?: string; // optional override under sandbox rules
};
```

Result proposal:

```ts
export type ShellExecResult = {
  exit_code: number | null;
  signal?: string | null;
  stdout: string;
  stderr: string;
  truncated: {
    stdout: boolean;
    stderr: boolean;
    combined: boolean;
  };
  duration_ms: number;
};
```

### 3.2 Permission behavior

`shell.exec` is user-initiated and does not require `ui.confirm.request`.

- confirm bypass is limited to `shell.exec` route.
- sandbox/path/network constraints still apply.
- denylist-style hard blocks (if configured as sandbox policy) still apply.

### 3.3 Execution engine reuse

Implementation may reuse the same low-level shell runner currently used by
runtime `bash` tool (`spawn(..., { shell: true, stdio: pipe })`), but route,
logging, and policy handling are separated.

---

## 4. Shell Selection Policy

Bang execution should respect user shell by default.

- default: user login shell (`$SHELL -lc <command>` on POSIX)
- fallback: `sh -lc <command>` if shell cannot be resolved
- Windows behavior follows platform-appropriate default shell policy

Goal: avoid forcing bash semantics when user environment expects zsh/fish-like
login shell behavior.

---

## 5. Injection Format and Escaping

### 5.1 Wrapper format

Inject queued results before the next user text as repeated blocks:

```text
<shell_result>
{...json...}
</shell_result>
```

JSON fields (phase 1):

- `id`
- `command_preview`
- `exit_code`
- `signal`
- `duration_ms`
- `stdout` (optional; omitted when too large)
- `stderr` (optional; omitted when too large)
- `stdout_excerpt` (optional)
- `stderr_excerpt` (optional)
- `stdout_cache_id` (optional)
- `stderr_cache_id` (optional)
- `truncated` (`stdout`/`stderr`/`combined`)

### 5.2 Escaping requirements

To avoid malformed wrapper parsing:

1. Never put command text in XML attributes.
2. Serialize JSON with escaping for `<` and `>` (`\u003c`, `\u003e`).
3. Keep a bounded `command_preview` length (for example 200-500 chars).

---

## 6. Output Size and Truncation Policy

### 6.1 Small output

If output size is below threshold, inline full `stdout`/`stderr` in JSON.

### 6.2 Large output

If output size exceeds threshold:

1. inline `head + tail` excerpts only
2. omit middle with explicit truncation markers
3. store full output in tool output cache and include cache IDs

Recommended truncation strategy:

- preserve first N lines and last M lines
- drop middle region
- include omitted line count when available

---

## 7. Tool Output Cache Contract

Use existing `tool_output_cache` for deferred full output retrieval.

Current compatibility baseline already supports line-range reads:

- `tool_output_cache({ ref_id, offset?, limit? })`

Planned backward-compatible extension:

- optional `head?: number`
- optional `tail?: number`

Rules:

1. Existing `offset/limit` behavior must stay unchanged.
2. New optional args must not break older callers.
3. Runtime may reject invalid arg combinations with `invalid params`.

---

## 8. TUI State Model Additions (Planned)

Add local queue state in `AppState`:

- `pending_shell_results: Vec<PendingShellResult>`

Flow:

1. `!cmd` -> execute `shell.exec` -> enqueue normalized result object.
2. Normal Enter submission -> prepend serialized `<shell_result>` blocks to
   user text payload.
3. On successful `run.start`, clear consumed entries.
4. On send error, keep queue.

---

## 9. Protocol/Package Changes (Planned)

### 9.1 `packages/protocol`

- add method: `shell.exec`
- add types: `ShellExecParams`, `ShellExecResult`
- add capability: `supports_shell_exec` (server capability)

### 9.2 `packages/runtime`

- implement RPC handler for `shell.exec`
- enforce no-confirm path for this method only
- emit structured logs/audit with `origin=ui_bang`

### 9.3 `crates/tui`

- intercept `!` in composer enter handler
- call `shell.exec`
- queue/inject `<shell_result>` blocks on next normal run

### 9.4 docs

- update `docs/specs/ui-protocol.md` method list and request section
- update `docs/specs/tui-operation-reference.md` with command surface note

---

## 10. Security Notes

1. This mode intentionally increases direct command power for UX.
2. Scope that power to explicit user input (`!`) only.
3. Keep sandbox constraints active.
4. Keep output bounded to prevent prompt flooding.
5. Keep full output retrieval explicit via cache reference.

---

## 11. Acceptance Criteria

1. `!git status` runs immediately without starting model run.
2. Result appears in queue and is injected on next normal message.
3. Injected format is `<shell_result>` with JSON payload (no attribute command).
4. Large output uses head/tail + cache IDs.
5. `shell.exec` skips confirm but still obeys sandbox restrictions.
6. Existing slash command and normal run flow remain unchanged.

---

## 12. Future Work

1. `!` command completion (PATH + history).
2. Dedicated shell result viewer panel (cache-aware).
3. Optional interactive shell pane/session mode.
4. Unify with remote-runtime SSH behavior for consistent local/remote UX.

---

## 13. References

- `docs/specs/ui-protocol.md`
- `docs/specs/tui-operation-reference.md`
- `docs/specs/tools.md`
- `docs/specs/permissions.md`
- `docs/specs/tui-remote-runtime-ssh.md`
- `packages/runtime/src/tools/bash-utils.ts`
- `packages/runtime/src/tools/tool-output-cache.ts`
