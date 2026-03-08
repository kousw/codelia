# Backlog

Implementation ideas and "nice-to-have" tasks that are not scheduled yet.

- **B-001** Web UI: compare provider-native payload (`ContentPart.other` / `provider_meta`) vs `BaseMessage` history for a session/run.
  Purpose: identify loss/transform points when reconstructing prompts, especially across providers/models.
  Notes: would benefit from visualizing persisted provider-native fields in `llm.response.output`.

- **B-035** Background shell execution mode (`shell.exec` async job style).
  Purpose: let users kick off long-running shell commands without blocking normal prompt interactions.
  Notes: define job lifecycle surface (start/list/status/cancel), output retrieval policy (stream vs cached pull), and integration with current bang/deferred `<shell_result>` behavior. Include promote flow from in-flight sync execution (for example `Ctrl+B` in TUI to detach current shell run into a background job).
  Specs: `dev-docs/specs/shell-background-execution.md`, `dev-docs/specs/task-orchestration.md`

- **B-036** TUI multiline input key portability (`Shift+Enter` in Windows Terminal / embedded terminals).
  Purpose: make newline insertion reliable when terminal environments do not forward modified Enter consistently.
  Notes: investigate Windows Terminal and embedded terminal hosts such as Cursor on macOS, validate keyboard protocol coverage, and consider a more explicit fallback/configuration path beyond the current `Ctrl+J` and backslash+`Enter` workarounds.

- **B-037** User-provided file and image loading in prompts.
  Purpose: let users attach local files or images to a turn explicitly when path-only prompting is clumsy or model-native image input is needed.
  Notes: cover TUI/CLI attachment UX, provider capability gating for multimodal models, persistence/storage policy for attached assets, and safe fallbacks when a provider cannot consume binary/image content directly.

- **B-038** Installed app automatic update flow.
  Purpose: keep CLI/TUI installs current without requiring users to manually watch releases or reinstall for every update.
  Notes: define update check UX (startup/background/manual), platform-aware apply paths for npm/global installs vs packaged binaries, restart/relaunch behavior, and security policy such as artifact verification plus opt-in vs auto-apply defaults.

- **B-031** TUI command handler split: break up `crates/tui/src/app/handlers/command.rs` into smaller focused modules.
  Purpose: reduce file complexity, improve maintainability/testability, and make queue/approval related changes safer.
  Notes: keep behavior unchanged; start with extraction by responsibility (prompt run start path, slash command parsing/execution, queue operations).

- **B-009** Optional usage/cost display per run (from `usage-tracking`).
  Purpose: visibility into usage without external tooling.
  Notes: scope boundary with diagnostics is defined in `dev-docs/specs/llm-call-diagnostics.md`.

- **B-025** TUI run timing (always-on): show elapsed time while `running` and retain total duration after completion in normal UI.
  Purpose: make long-running operations easier to monitor without enabling any debug/diagnostic mode.

- **B-026** Diagnostics panel/flag (`--diagnostics`): expose run-level diagnostics (summary usage/cost, provider metadata, and troubleshooting signals).
  Purpose: provide deeper observability when explicitly requested.
  Notes: overlaps with **B-009**; boundary and wire proposal are documented in `dev-docs/specs/llm-call-diagnostics.md`.

- **B-039** Opt-in runtime/TUI resource profiler (memory/CPU/latency).
  Purpose: make it practical to investigate resource spikes, leaks, and slowdowns without attaching ad hoc external profilers every time.
  Notes: define a lightweight opt-in trigger (flag/command/manual snapshot), what to capture for Bun runtime vs Rust TUI processes, artifact/output format for issue reports, and the boundary between always-on diagnostics and heavier profiling.

- **B-010** Provider extensions: Gemini provider.
  Purpose: broaden model/provider options beyond current OpenAI/Anthropic baseline.
  Notes: Skills support is already implemented; this item tracks remaining provider expansion.

- **B-012** TUI output: `ansi-to-tui` to render ANSI-colored tool output safely in ratatui.
  Purpose: preserve formatting while keeping the UI stable.

- **B-014** Desktop file tree: add filesystem watcher + incremental refresh (rename/create/delete).
  Purpose: keep explorer state in sync without full reloads on each action.

- **B-015** Desktop diff viewer: staged/unstaged switch, file list pane, and hunk navigation.
  Purpose: make larger patch review practical inside the GUI client.

- **B-016** Desktop diff rendering: syntax-aware highlighting for code hunks (optional).
  Purpose: improve readability after unified diff MVP is stable.

- **B-017** Selection/search UX: evaluate `nucleo-matcher` for fast fuzzy filtering in lists/pickers.
  Purpose: make model/session/tool selection responsive at scale.

- **B-018** Code blocks: consider `tree-sitter` + `tree-sitter-highlight` for rich code highlighting (optional, heavier dependency).
  Purpose: enhance code readability when needed without making it mandatory.

- **B-023** Lane completion/attention notification: notify operator when a lane finishes/errors or is blocked in permission/UI-confirm wait (`awaiting_ui`-like attention state).
  Purpose: reduce manual polling/attach overhead by surfacing lane attention events (log badge, optional terminal/OS notification, and/or tmux-friendly signaling).

- **B-024** Protocol schema/codegen for runtime ⇄ TUI boundary: define method params/results/events in a single schema source and generate TS/Rust boundary types/decoders.
  Purpose: reduce manual drift, avoid raw JSON passthrough in UI parsing, and fail fast with type errors when protocol fields change.

- **B-032** Lane resume helper (`lane_resume`): recreate a runnable lane from a previous lane id/context.
  Purpose: make recovery from finished/dead tmux sessions one-command instead of manual `base_ref`/worktree reconstruction.
  Notes: should carry forward useful context (task id, branch/base ref, worktree, seed context).

- **B-033** Lane backend restart (`lane_reopen`): recreate multiplexer session for an existing lane/worktree when backend is dead.
  Purpose: recover quickly from tmux/zellij session loss without creating an unrelated new lane.
  Notes: keep lane metadata continuity and provide a deterministic attach target.

- **B-034** Lane checkpoint/handoff metadata.
  Purpose: persist concise execution context (goal, pending tasks, dirty files, recommended verify commands) to improve resume quality.
  Notes: can be emitted automatically at finish/error and consumed by resume flows.

- **B-029** Terminal-Bench support (Harbor integration + headless benchmark mode).
  Purpose: run reproducible terminal-agent evaluations against Terminal-Bench datasets and compare Codelia behavior over time.
  Notes: requires non-interactive permission policy design (`full-access` approval mode for benchmark runs, with `minimal`/`trusted` retained for normal usage), a headless CLI/runtime entrypoint, and ATIF trajectory export/validation.
  Spec: `dev-docs/specs/terminal-bench.md`

- **B-030** Subagents MVP (delegated child-agent execution with bounded scope).
  Purpose: decompose complex tasks into smaller executions while keeping the parent loop predictable and auditable.
  Notes: start with non-recursive delegation (`parent -> child` only), isolated child history/session, explicit tool allowlist + token/step budget, and structured child result (`status`, `summary`, `artifacts`). Keep planner-style deep hierarchy and long-term memory integration out of MVP scope.
  Spec: `dev-docs/specs/task-orchestration.md`
