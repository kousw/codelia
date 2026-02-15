# Backlog

Implementation ideas and "nice-to-have" tasks that are not scheduled yet.

- **B-001** Web UI: compare provider-native payload (`ContentPart.other` / `provider_meta`) vs `BaseMessage` history for a session/run.
  Purpose: identify loss/transform points when reconstructing prompts, especially across providers/models.
  Notes: would benefit from visualizing persisted provider-native fields in `llm.response.output`.

- **B-002** TUI input log: preserve input newlines as-is in the log; optionally keep an "input background strip" while new logs stream.
  Purpose: keep readability when multi-line inputs are sent and logs scroll.

- **B-005** Input queueing while a run is active (enqueue subsequent inputs; allow cancel/clear queue).
  Purpose: avoid accidental drops; make multi-turn usage smoother without interrupting active runs.

- **B-006** Edit diff display for edit results; evaluate Rust diff libs (`similar`, `imara-diff`) and styling.
  Purpose: make edit outcomes scannable without opening files.

- **B-007** Input history: up/down recall and quick resend of last input.
  Purpose: faster iteration and recovery after interrupts.

- **B-009** Optional usage/cost display per run (from `usage-tracking`).
  Purpose: visibility into usage without external tooling.

- **B-010** Provider extensions: Gemini provider.
  Purpose: broaden model/provider options beyond current OpenAI/Anthropic baseline.
  Notes: Skills support is already implemented; this item tracks remaining provider expansion.

- **B-011** TUI rendering: consider `pulldown-cmark` + `textwrap` + `unicode-width/segmentation` for more robust Markdown and wrapping.
  Purpose: improve readability for multi-language text and structured content.

- **B-012** TUI output: `ansi-to-tui` to render ANSI-colored tool output safely in ratatui.
  Purpose: preserve formatting while keeping the UI stable.

- **B-013** TUI diff view: use `similar` (or current `diffy`) for an inline edit diff widget.
  Purpose: quick scan of edit results without opening files.

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

- **B-019** Error display: show concise, actionable error summaries (with optional detail expansion).
  Purpose: make failures easier to grasp quickly without hiding diagnostics.

- **B-021** Search tool support: provide a unified search tool and leverage platform-native search tools (e.g., OpenAI-provided search) when available.
  Purpose: improve retrieval quality and capability by using provider-optimized search paths while keeping a consistent agent interface.

- **B-023** Lane completion/attention notification: notify operator when a lane finishes/errors or is blocked in permission/UI-confirm wait (`awaiting_ui`-like attention state).
  Purpose: reduce manual polling/attach overhead by surfacing lane attention events (log badge, optional terminal/OS notification, and/or tmux-friendly signaling).

- **B-024** Protocol schema/codegen for runtime ⇄ TUI boundary: define method params/results/events in a single schema source and generate TS/Rust boundary types/decoders.
  Purpose: reduce manual drift, avoid raw JSON passthrough in UI parsing, and fail fast with type errors when protocol fields change.
