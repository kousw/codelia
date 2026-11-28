# Backlog

Deferred work inventory organized by topic. New items do not use numeric `B-NNN` IDs (legacy IDs remain only where existing specs link to them; retired IDs are never reused).

## Runtime & Sandbox

<a id="cloud-gvisor"></a>

- **Hosted Linux workers with gVisor** (legacy `B-043`): Evaluate gVisor (`runsc`) for hosted Linux workers, reusing Codelia's sandbox permission contract and acceptance tests when hosted workers are in scope. [Local sandbox design](./command-approval-reference.ja.md#mxc-evaluation)

- **Subagent orchestration follow-ups** (legacy `B-030`): Core shared-workspace children, bounded concurrency/steps, deadlines, delegated permission caps, session-owned lifetime, and parent-mediated collaboration are implemented (`packages/runtime/src/subagents/`, [`subagent-collaboration.md`](./subagent-collaboration.md)). Remaining: aggregate token/cost enforcement, recursive children, and worktree leases ([`task-orchestration.md`](./task-orchestration.md)).

- **Opt-in heavy CPU/heap profiler snapshots and issue-report export**: Lightweight live Telemetry + TUI Perf (`Alt+P`/`/perf`), `/stats` (`/diag`), and `telemetry.get` runtime memory/phase telemetry are implemented. Remaining: opt-in deep CPU/heap snapshot triggers and export bundles for investigating sustained spikes/leaks.

## Tools

- **Future built-in tool additions**: `apply_patch`, `webfetch`, `view_image`, and TUI-local `tui_ask_user_choice` are implemented. Remaining: `lsp`, MCP resource tools, and cross-host `request_user_input` (generalizing interactive user questions beyond TUI-local client tools; keep split todo tools as-is unless evidence changes). [`future-tools.md`](./future-tools.md)

## TUI & UX

- **Clipboard file and image attachments follow-ups**: `Alt+V` copied file-list/image paste, immutable originals, bounded transfers, and session-owned reads are implemented. Remaining: native clipboard acceptance across target platforms, format-specific readers, and long-term blob garbage collection. [`input-attachments.md`](./input-attachments.md)

- **TUI multiline input key portability (`Shift+Enter`)**: Investigate Windows Terminal and embedded terminal hosts (such as Cursor on macOS), validate keyboard protocol coverage, and evaluate explicit configuration/fallbacks beyond `Ctrl+J` and backslash+`Enter`.

- **TUI live run elapsed timing**: `crates/tui/src/app/app_state/methods.rs` tracks duration and `crates/tui/src/app/handlers/runtime_response/apply.rs` / `status.rs` display it on completion. Remaining: show live elapsed time while a run is active and assess terminal error/cancellation display.

- **Fuzzy picker filtering (`nucleo-matcher`)**: Evaluate fast fuzzy filtering for large model/session/tool pickers at scale.
