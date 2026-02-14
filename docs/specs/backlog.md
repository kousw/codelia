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

- **B-010** Provider extensions: Skills support, Gemini provider.
  Purpose: broaden integrations and model options.
  Notes: Skills design baseline is documented in `docs/specs/skills.md`.

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

- **B-020** Add `/logout` command to clear current auth/session credentials and return to signed-out state.
  Purpose: allow safe account switching and explicit local credential reset from the UI.

- **B-021** Search tool support: provide a unified search tool and leverage platform-native search tools (e.g., OpenAI-provided search) when available.
  Purpose: improve retrieval quality and capability by using provider-optimized search paths while keeping a consistent agent interface.
