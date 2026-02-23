# Backlog

Implementation ideas and "nice-to-have" tasks that are not scheduled yet.

- **B-001** Web UI: compare provider-native payload (`ContentPart.other` / `provider_meta`) vs `BaseMessage` history for a session/run.
  Purpose: identify loss/transform points when reconstructing prompts, especially across providers/models.
  Notes: would benefit from visualizing persisted provider-native fields in `llm.response.output`.

- **B-002** TUI input log: preserve input newlines as-is in the log; optionally keep an "input background strip" while new logs stream.
  Purpose: keep readability when multi-line inputs are sent and logs scroll.

- **B-005** Input queueing while a run is active (enqueue subsequent inputs; allow cancel/clear queue).
  Purpose: avoid accidental drops; make multi-turn usage smoother without interrupting active runs.
  Notes: detailed behavior is defined in `docs/specs/tui-input-queueing.md`.

- **B-031** TUI command handler split: break up `crates/tui/src/app/handlers/command.rs` into smaller focused modules.
  Purpose: reduce file complexity, improve maintainability/testability, and make queue/approval related changes safer.
  Notes: keep behavior unchanged; start with extraction by responsibility (prompt run start path, slash command parsing/execution, queue operations).

- **B-009** Optional usage/cost display per run (from `usage-tracking`).
  Purpose: visibility into usage without external tooling.
  Notes: scope boundary with diagnostics is defined in `docs/specs/llm-call-diagnostics.md`.

- **B-025** TUI run timing (always-on): show elapsed time while `running` and retain total duration after completion in normal UI.
  Purpose: make long-running operations easier to monitor without enabling any debug/diagnostic mode.

- **B-026** Diagnostics panel/flag (`--diagnostics`): expose run-level diagnostics (summary usage/cost, provider metadata, and troubleshooting signals).
  Purpose: provide deeper observability when explicitly requested.
  Notes: overlaps with **B-009**; boundary and wire proposal are documented in `docs/specs/llm-call-diagnostics.md`.

- **B-027** Per-LLM-call diagnostics: show call-by-call metadata (model, latency, token usage, and cache hit/miss where provider supports it).
  Purpose: make cache behavior and request-level differences visible for tuning/debugging.
  Notes: per-call field definitions and derived cache-hit semantics are documented in `docs/specs/llm-call-diagnostics.md`.

- **B-010** Provider extensions: Gemini provider.
  Purpose: broaden model/provider options beyond current OpenAI/Anthropic baseline.
  Notes: Skills support is already implemented; this item tracks remaining provider expansion.

- **B-011** TUI rendering: consider `pulldown-cmark` + `textwrap` + `unicode-width/segmentation` for more robust Markdown and wrapping.
  Purpose: improve readability for multi-language text and structured content.

- **B-028** TUI text wrap indent continuation: preserve/maintain logical indentation when long lines wrap (including list/code/quoted contexts).
  Purpose: keep wrapped output readable and structurally clear instead of flattening continuation lines.
  Notes: likely non-trivial because it intersects with width measurement, span rendering, and multi-span token color handling. Spec: `docs/specs/tui-wrap-indent-continuation.md` (Phase 1 viewport continuation indent, Phase 2 insertion wrap parity, Phase 3 unit + VT100 validation).

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
  Spec: `docs/specs/terminal-bench.md`

- **B-030** Subagents MVP (delegated child-agent execution with bounded scope).
  Purpose: decompose complex tasks into smaller executions while keeping the parent loop predictable and auditable.
  Notes: start with non-recursive delegation (`parent -> child` only), isolated child history/session, explicit tool allowlist + token/step budget, and structured child result (`status`, `summary`, `artifacts`). Keep planner-style deep hierarchy and long-term memory integration out of MVP scope.
