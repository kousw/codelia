# codelia-tui

Full-screen TUI built with Ratatui and crossterm. Display the logo, conversation log history, input field, and status line at the top.
Don't use alternate screen, adjust the inline viewport according to the required height of the UI and draw in the normal buffer. MouseCapture is OFF by default.
Spawn the runtime, send initialize/run.start via the UI protocol, and display events.
In initialize, send `ui_capabilities.supports_confirm=true`.
When receiving `ui.confirm.request` from runtime, display a confirmation panel, press Y/Enter to accept or N/Esc to reject.
The options on the confirmation panel (label/remember/reason) are controlled by request params, and the UI for Yes/No or authority confirmation can be switched for each purpose.
The input field functions as a chat input area, and pressing Enter sends `run.start` (chat format).
`Alt+V` tries to paste a clipboard image (`arboard`) and attaches it to the next `run.start` as `input.type="parts"` (`image_url` data URL).
On WSL, when native clipboard image read fails, the TUI tries Windows clipboard fallback via `powershell.exe`.
The composer stores image placeholders as internal tokens and renders them as `[Image N]` at the cursor insertion point.
When image attachments exist, the status line shows the attachment count, and `Esc` clears both text input and pending attachments.
You can select a session to resume by calling session.list with `-r/--resume` (assign session_id to run.start).
Call session.history in resume and redraw agent.event of the past run.
The `/model` command displays the provider selection → model list (details) in the input field panel, and sends model.set by pressing Enter.
In the model list panel, `Tab` switches the table between token limits view and cost view.
When runtime requests startup onboarding model selection (`ui.pick.request` with `Select model (<provider>)`), TUI renders it with the same model list panel style instead of the generic pick list.
Call runtime's `mcp.list` with `/mcp` / `/mcp <server-id>` and display the MCP server status.
Call runtime's `skills.list` on `/skills` and display the skills picker panel.
In the skills picker, search using the type input, `Tab` to switch scope (all/repo/user), `Space`/`e` toggle enable/disable, and `Enter` to insert `$skill-name` into the input field.
Call runtime's `context.inspect` in `/context` (`/context brief`) to list the current context including the load path of AGENTS.md.
Send `run.start(force_compaction=true)` with `/compact` to force compaction to run without normal user input.
Send `auth.logout(clear_session=true)` with `/logout` and clear the saved auth and current session references after approving the confirmation dialog.
Display a list of slash commands available in `/help` in the log.
When the input field starts with `/`, slash command candidates are displayed at the bottom of the input panel.
When the last token of the input field is `$skill-prefix`, skill candidates are displayed at the bottom of the input panel (based on local catalog).
Unknown slash commands are not sent as messages; instead, display `command not found` (with `/help` guidance).
If you press `Tab` during normal input, slash command completion will be prioritized, and if not applicable, `$skill-prefix` will be completed (unique match is confirmed + blank, multiple matches are up to the common prefix).
The selection UI displays an expanded panel of input fields (close with Esc). `>` is displayed on the left of the selected line.
Logs are displayed color-coded (user/reasoning/tool/result/status/runtime) and inline mode.
Insert the overflowing log lines into the terminal's scrollback and leave them as history.
Each action is displayed as a summary line with an icon on the left + a detail line with a light indentation, and the color tone changes between summary/details.
Log wrapping is cached in AppState (`width + log_version` key) so spinner-only redraws don't re-wrap the full log.
During execution, a spinner is displayed on the status line, and upon completion, the processing time is inserted just before the final response.
run.start While waiting for a response, display `starting` and rotate the spinner to visualize waiting for MCP connection.
MCP connections that require OAuth display a browser startup confirmation dialog and wait at `awaiting_ui` until the localhost callback completes.
`mcp: Connecting MCP server` / `mcp: MCP auth required` / `mcp: MCP server ready` are displayed as the Status line even if debug print is OFF.
`mcp[... ] connect failed` / `MCP server error` are displayed as Error lines even if debug print is OFF.
The general log for `[runtime]` remains hidden when debug print is OFF, and only lines that can clue you into a crash, such as `Error:` and `panic`, are always displayed as Error lines.
`--debug-perf` (or `CODELIA_DEBUG_PERF=1`) adds a fixed performance panel below the status line (frame/draw time and wrap-cache stats).
prompt / confirm The panel body is drawn wrapped by the panel width. The confirm panel prioritizes displaying the last part so that the option block (Yes/No/remember) is always visible even if the text is long.
`secret=true` of `ui.prompt.request` masks and displays the input content with `*` (the sent value is retained).
In order to support horizontal scrolling in Japanese input, the input field takes into account unicode width.
Since assistant messages are based on markdown, minimal simple rendering (removal of code fences, headings, bullet points, quotations, and inline decorations) is performed.
Since the tool result / code block may contain control characters and ANSI escapes, sanitize it on the TUI side before drawing it (tab expansion, ANSI strip, CR removal).
Paste into the input field is formatted with `sanitize_paste`, normalizes CRLF/CR to LF while preserving line breaks, and normalizes tab/control characters.
Enable bracketed paste on startup to avoid misinterpreting multiline pastes as consecutive Enter presses.
Terminal mode return (raw mode / bracketed paste / keyboard enhancement flags / mouse capture / cursor) is guaranteed with Drop guard.

Module structure:
- `src/main.rs`: crossterm event loop, connection with runtime, drawing trigger
- `src/handlers/command.rs`: slash command processing and normal input submit branch
- `src/handlers/panels.rs`: model/session/context Key operation handler for each panel
- `src/runtime.rs`: runtime spawn + initialize/run.start send
- `src/parse.rs`: Parse runtime JSON line and convert it to LogLine
- `src/ui.rs`: ratatui drawing (logo/log/input/status)
- `src/input.rs`: Edit/history of input field
- `src/markdown.rs`: Simple rendering of assistant markdown
- `src/model.rs`: LogKind / LogLine
- `src/text.rs`: unicode width, wrap, sanitize

Execution example (for development):
- cargo run --manifest-path crates/tui/Cargo.toml
- CODELIA_RUNTIME_CMD=bun CODELIA_RUNTIME_ARGS="packages/runtime/src/index.ts" cargo run --manifest-path crates/tui/Cargo.toml "hi"
- Add CODELIA_DEBUG=1 to display runtime/RPC logs

operation:
- Type and press Enter to send
- Line break: `Ctrl+J` (`Shift+Enter` is also possible on compatible terminals, but cannot be distinguished depending on the terminal/IME)
- Even in multiline input of `ui.prompt.request`, line break can be done with `Ctrl+J`.
- `Up/Down` during multi-line input moves the cursor between lines, and falls back to history movement at the top and bottom edges.
- Log scroll: `PgUp` / `PgDn` / Mouse wheel (with MouseCapture enabled)
- Switch status line Info/Help with `Alt+H`
- Paste clipboard image attachment with `Alt+V` (up to 3 images, 5 MiB encoded each)
- MouseCapture on/off with `F2` (off is recommended when you want to copy)
- `Esc` goes back (close panel/unscroll/clear input)
- terminate with `Ctrl+C`

At startup:
- Call `model.list` to initially load the current provider/model (no panel will open).
- Runtime may immediately request first-run onboarding picks/prompts (provider/auth/model) when no auth is configured.
- In the case of `supports_skills_list=true`, obtain `skills.list` once in the background and warm up the catalog of `$skill` completion candidates.

Key input notes:
- To ensure that `Shift+Enter` is obtained, the terminal needs to send modifier information. I tried enabling the kitty keyboard protocol on the TUI side, but on unsupported terminals `Shift+Enter` cannot be distinguished from normal `Enter` (in that case, use `Ctrl+J` / `Alt+Enter`). If you enable `REPORT_ALL_KEYS_AS_ESCAPE_CODES`, the extended key protocol itself will fail on some terminals and the modifier keys will drop, so do not use it.
