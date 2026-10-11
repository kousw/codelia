# Native views

Use neutral light palette and readable system font. Keep header/composer compact; child hierarchy belongs in sidebar and only selected results in inspector. Changes and child inspector are mutually exclusive; narrow inspector views hide navigation. Override MessageScroller's default row spacing explicitly. Preserve user fold/scroll choice. Native focus, shortcut, long-text, approval and narrow-window checks must accompany layout changes; never claim them from a code-only build.

Size header status by available conversation width, accounting for navigation/inspector. At narrow widths the sessions toggle closes the inspector to reveal navigation. Icon actions need accessibility labels and tooltips; the Changes pane has its own close action. Headless bounds/input tests validate interactions, not pixels or OS IME.

Keep the project-worktree list bounded/scrollable and Changes optional. New from HEAD is explicit; the runtime confirms exact scope, rendered as literal text rather than Markdown. Creation and opening remain separate. Missing/unknown status is never rendered clean; disable unavailable rows and create during pending input/history/creation.

Composer shows actual generic draft save/recovery/failure status and Clear draft. Pre-admission saving exposes Cancel send; parent Stop retains its existing child-lifetime semantics. Clear/cancel/failure restores focus/input after exact completion. Normal close with failed save keeps the window open; Quit without saving is explicit. Do not claim OS/IME behavior from the headless checks.

Provider/model controls remain next to composer even after model.list failure. Connected transport is distinct from model-ready; Send and keyboard use shared validation. Worktree diagnostics are collapsed behind working Details toggle; same-named folders show distinguishing path, full path on hover.
