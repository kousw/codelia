# TUI Terminal Mode Selection

Status: `Mixed`

This document defines Codelia's current terminal-buffer behavior and the target
contract for selecting between native-scrollback and alternate-screen rendering.

The implemented startup contract is:

1. explicit `inline | alternate | auto` modes; and
2. conservative `auto` resolution from the host terminal environment.

Live mode switching and split-footer rendering are follow-up work, not part of
the initial implementation.

---

## 1. Goals

- Preserve native terminal scrollback as the preferred experience where it is
  reliable.
- Provide an alternate-screen mode that avoids inline scrolling-region behavior
  on incompatible terminal stacks, especially Windows Terminal/ConPTY/WSL.
- Make the selected behavior explicit, deterministic, and diagnosable.
- Keep mode-specific setup, rendering effects, mouse defaults, and cleanup behind
  one resolved terminal-mode boundary.
- Avoid coupling terminal-mode selection to multiplexers or terminal brands when
  a smaller platform-level rule is sufficient.
- Preserve a path toward Pi-style live switching without requiring it for the
  first implementation.

## 2. Non-goals for the first implementation

- Switching renderer mode while a Codelia process is running.
- Replaying the full transcript into the main screen when alternate mode exits.
- Implementing OpenCode-style split-footer rendering.
- Adding terminal capability probing or a database of terminal-emulator quirks.
- Guaranteeing identical scrollback behavior across all terminal emulators and
  multiplexers.

---

## 3. Current implementation

The following behavior is implemented now:

- `crates/tui/src/entry/cli.rs` parses `--tui-mode` and
  `CODELIA_TUI_MODE` before runtime startup; CLI selection takes precedence and
  the default requested mode is `auto`.
- `crates/tui/src/entry/terminal_mode.rs` captures platform/WSL facts and
  resolves the requested mode once to typed `Inline` or `Alternate` behavior.
- `auto` resolves to alternate on native Windows and WSL, and inline elsewhere.
- `crates/tui/src/entry/terminal.rs` contains both setup paths:
  - inline uses Ratatui `Viewport::Inline`;
  - alternate executes `EnterAlternateScreen` and uses the normal fullscreen
    Ratatui viewport.
- Inline rendering uses `Terminal::insert_before` from
  `crates/tui/src/app/render/inline.rs` to move completed wrapped rows into the
  terminal's native scrollback.
- Inline mode restores the shell cursor below the viewport on exit.
- Alternate mode skips inline insertion and cursor restoration, defaults mouse
  capture on, and leaves the alternate screen through `TerminalRestoreGuard`.
- Inline mode defaults mouse capture off. `F2` remains the manual mouse-capture
  toggle in both modes.
- Startup failures after spawning the runtime still pass through child cleanup;
  invalid terminal-mode input fails before the child starts.

The semantic validation boundary for the implemented inline path remains defined
in [`tui-inline-scrollback-validation.md`](./tui-inline-scrollback-validation.md).

---

## 4. Reference model: Pi

Pi is the primary design reference for mode separation. Its relevant properties
are:

- the user-facing mode is explicit (`regular` or `fullscreen`), with regular as
  the native-scrollback default;
- regular and fullscreen are separate renderer implementations rather than one
  renderer containing scattered terminal checks;
- renderer construction is centralized in a composition function;
- live switching stops the previous renderer, preserves the terminal, transfers
  components and focus, and restores regular-renderer state when returning;
- fullscreen exit can switch back to regular and render the transcript before
  returning control to the shell.

Relevant upstream files as inspected on 2026-08-16:

- `packages/coding-agent/src/cli/args.ts`
- `packages/coding-agent/src/core/settings-manager.ts`
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- `packages/tui/src/tui-main-screen.ts`
- `packages/tui/src/tui-alt-screen.ts`

Codelia adopts Pi's separation of requested mode, resolved renderer, and renderer
lifecycle. Codelia does not initially adopt Pi's live switching or transcript
replay because its Ratatui terminal and render-state ownership must first be made
mode-aware at startup.

Grok Build is a secondary reference for resolving an `auto` mode from the
terminal environment. Codelia's initial matrix is intentionally smaller than
Grok Build's terminal-specific fallback matrix.

---

## 5. Mode model

### 5.1 Requested mode

The user-facing mode is:

```text
auto | inline | alternate
```

- `inline`
  - Render in the terminal main buffer using Ratatui `Viewport::Inline`.
  - Preserve native terminal scrollback.
  - Apply Codelia's inline history-insertion effects.
- `alternate`
  - Enter the terminal alternate screen before rendering.
  - Keep conversation scrolling inside the TUI.
  - Do not insert completed rows into native terminal scrollback.
- `auto`
  - Resolve once during startup to either `inline` or `alternate` using the
    policy in section 7.

`auto` is a requested mode, not a third renderer. Rendering code receives only a
resolved mode.

### 5.2 Resolved mode

Internal mode-sensitive code should use a typed value equivalent to:

```rust
enum ResolvedTerminalMode {
    Inline,
    Alternate,
}
```

A raw `bool` such as `use_alt_screen` must not remain the cross-module policy
boundary. The enum should own or expose mode-specific predicates such as:

- whether to enter/leave alternate screen;
- whether inline terminal effects are enabled;
- whether inline cursor restoration is required;
- the initial mouse-capture default.

This keeps additional modes or renderers from creating boolean combinations with
unclear semantics.

---

## 6. Configuration and precedence

The implemented startup selection is exposed through:

```text
--tui-mode <auto|inline|alternate>
CODELIA_TUI_MODE=auto|inline|alternate
```

Resolution precedence is:

1. `--tui-mode` command-line argument;
2. `CODELIA_TUI_MODE` environment variable;
3. built-in default `auto`.

Requirements:

- Both `--tui-mode=value` and `--tui-mode value` forms are accepted.
- Values are case-insensitive after trimming.
- Missing or unknown values are startup errors with the accepted values in the
  message.
- Parsing and resolution occur before spawning the runtime child process or
  mutating terminal state.
- The help output documents the flag, accepted values, and `auto` default.
- The resolved mode and reason are available to debug diagnostics without being
  printed during normal startup.

A persisted global/project setting is deferred. When added, its precedence
should be below the environment variable and above the built-in default. The
storage location and scope must be specified with that implementation rather
than introduced ad hoc in the Rust TUI.

Compatibility aliases such as `--no-alt-screen` are not required for the first
implementation. They may later map to `inline` without changing the canonical
mode names.

---

## 7. Initial `auto` policy

The implemented initial policy is deliberately conservative and platform-based:

| Condition, evaluated in order | Resolved mode | Reason code |
| --- | --- | --- |
| Native Windows target | `alternate` | `windows-conpty` |
| WSL environment detected | `alternate` | `wsl-conpty` |
| Otherwise | `inline` | `native-scrollback` |

WSL detection should use stable environment/kernel indicators already available
to the process, such as `WSL_INTEROP`, `WSL_DISTRO_NAME`, or a Linux kernel
release containing the Microsoft WSL marker. The detector must be a pure,
unit-testable function over captured environment/platform facts.

Policy constraints:

- An explicit `inline` or `alternate` request always overrides `auto`.
- `tmux` and Zellij do not independently force alternate mode in the initial
  policy; on non-WSL Unix hosts they resolve to inline, preserving current
  behavior.
- Terminal brand heuristics (`TERM_PROGRAM`, executable names, and similar) are
  excluded until a reproducible incompatibility requires one.
- `auto` resolution happens once at startup. Resize, SSH attachment, or
  multiplexer changes do not switch the renderer during the process.
- A terminal setup failure is an error, not a silent retry in another mode. A
  partially entered terminal state must still be restored.

The Windows/WSL fallback is an initial compatibility policy, not a claim that all
ConPTY versions fail with inline mode. It should be relaxed only after manual
validation demonstrates reliable native scrollback behavior.

---

## 8. Mode-specific behavior

### 8.1 Inline

- Construct `Viewport::Inline` using the desired initial height.
- Keep mouse capture off by default so terminal wheel scrolling remains native.
- Continue applying `apply_terminal_effects` and `Terminal::insert_before` only
  when the user follows the latest output.
- Preserve the existing insertion boundary rule: advance `inserted_until` only
  after successful insertion.
- On exit, leave the rendered transcript visible and place the shell cursor below
  the inline viewport.

### 8.2 Alternate

- Execute `EnterAlternateScreen` before constructing/drawing the terminal.
- Use the full terminal area rather than an inline viewport height.
- Enable mouse capture by default, while preserving `F2` as an explicit toggle.
- Never call inline history insertion or inline cursor restoration.
- On exit or unwind, disable mouse capture, bracketed paste, keyboard
  enhancements, and raw mode; leave the alternate screen; then show the cursor.
- Return to the main screen exactly as it existed before startup. The first
  implementation does not print or replay the Codelia transcript on exit.

### 8.3 Shared behavior

- Application state, runtime session state, input handling, dialogs, and layout
  remain renderer-independent.
- Terminal cleanup must be idempotent and safe after partial setup.
- The resolved mode must be passed through startup and the run loop as a typed
  value, not recomputed in rendering code.
- Mode-specific rendering effects must be selected at one clear boundary after a
  frame draw.

---

## 9. Startup lifecycle

The implemented startup sequence is:

1. Parse basic CLI mode (`help`, `version`, or run).
2. Parse and validate requested terminal mode.
3. Capture platform/environment facts and resolve `auto`.
4. Spawn/initialize the runtime using the existing startup boundary.
5. Build application state and calculate inline height if the resolved mode is
   inline.
6. Install a restoration guard capable of tracking partially completed terminal
   setup.
7. Enter the resolved terminal mode and enable raw/input features.
8. Apply the mode's default mouse-capture state and enter the event loop.

Invalid mode configuration must not start a runtime child or mutate terminal
state. If later startup fails after the child starts, normal startup cleanup must
still terminate the child and restore any partially enabled terminal features.
No terminal mutation may occur for `--help`, `--version`, or invalid mode input.

---

## 10. Live switching: deferred Pi-inspired phase

Live `inline <-> alternate` switching is not required for the first
implementation. A later phase may add a settings action or command, but it must
satisfy all of the following before being enabled:

- overlays and modal ownership have a defined switch policy;
- focused component and composer contents survive the switch;
- inline render state (`inserted_until`, visible boundary, cursor phase, and wrap
  width) is captured or safely rebuilt;
- the existing terminal instance/backend can be reconfigured safely, or terminal
  reconstruction has an explicit ownership boundary;
- switching to alternate does not erase existing native scrollback;
- returning to inline does not duplicate transcript rows;
- exit behavior from alternate defines whether to restore the old main screen or
  append a transcript, following Pi's explicit `fullscreenExitOutput` model;
- switching failure leaves one valid renderer active and restores terminal
  modes.

Until these conditions are implemented and tested, changing `--tui-mode` or the
environment requires restarting Codelia.

---

## 11. Split-footer: separate follow-up

An append-only transcript with a mutable composer/footer may eventually replace
or supplement Ratatui `insert_before` on terminal stacks where scrolling regions
are unreliable. This is a separate renderer architecture, similar in principle
to OpenCode's `split-footer` mode.

It is not part of `inline | alternate | auto` because:

- it changes transcript ownership and frame composition rather than merely
  selecting a terminal buffer;
- it requires a stable append-only projection of completed log components;
- transient tool/status updates need a commit/finalization contract;
- resize and wrapped-row accounting differ from the current full-frame renderer.

The mode-selection implementation should avoid boolean APIs that would block a
future third resolved renderer, but it must not implement split-footer
prematurely.

---

## 12. Verification contract

### 12.1 Automated tests

Focused tests cover:

- parsing all CLI/env values and rejecting invalid/missing values;
- precedence: CLI over environment over default;
- `auto` resolution for native Windows, WSL indicators, ordinary Linux, and
  macOS;
- explicit-mode override on Windows/WSL;
- mode-derived predicates for alternate entry, inline effects, cursor restore,
  and mouse defaults;
- preservation of all existing inline history-insertion tests;
- ensuring alternate mode does not execute inline insertion effects.

Pure mode resolution must not depend directly on process-global environment in
tests; capture facts first and pass them to the resolver.

### 12.2 Manual terminal matrix

The default has changed from hardcoded inline to `auto`. Before declaring the
Windows/WSL compatibility path manually validated, smoke-test both explicit
modes and the expected auto result on:

- Ghostty or another native Unix terminal;
- tmux;
- Zellij;
- Windows Terminal running native PowerShell, when a native Windows build is
  available;
- Windows Terminal -> PowerShell -> WSL;
- a terminal 12 rows high or smaller;
- resize during active streaming and after enough output to overflow the
  viewport;
- normal exit and forced `Ctrl+C` exit;
- mouse capture off/on behavior through `F2`.

For inline mode, confirm that the shell resumes below a usable transcript in
native scrollback. For alternate mode, confirm that the original main screen is
restored without leaked raw mode, mouse reporting, or cursor state.

---

## 13. Delivery phases

### Phase 1: explicit mode plumbing — implemented

- Add requested/resolved terminal-mode types.
- Add CLI/environment parsing and help.
- Replace cross-module `use_alt_screen: bool` parameters with the resolved mode.
- Exercise the already-present inline and alternate setup paths.
- Add parser, lifecycle-predicate, and explicit-mode tests.

### Phase 2: `auto` resolution — implemented; compatibility smoke pending

- Add pure platform/environment fact capture and resolver.
- Default requested mode to `auto`.
- Resolve Windows and WSL to alternate; retain inline elsewhere.
- Add Windows/WSL to the manual validation matrix.
- Document any reproducible exception before adding more heuristics.

### Phase 3: live mode switching — deferred

- Add Pi-style renderer replacement and state transfer.
- Define persisted setting and fullscreen-exit transcript behavior.
- Add switch failure recovery and duplicate-transcript tests.

### Phase 4: split-footer renderer — separate/deferred

- Define append-only transcript projection.
- Keep mutable status/composer rows application-owned.
- Evaluate it as a replacement for inline scrolling-region insertion on
  ConPTY/WSL.

---

## 14. Implemented acceptance criteria for phases 1 and 2

- `--tui-mode inline` preserves the current native-scrollback behavior.
- `--tui-mode alternate` enters and cleanly leaves the alternate screen.
- The default requested mode is `auto`.
- `auto` resolves to alternate on native Windows and WSL, and inline on other
  currently supported Unix environments.
- Explicit mode selection overrides the automatic result.
- Invalid mode input fails before terminal mutation and runtime startup.
- Inline-only effects cannot run in alternate mode.
- Existing inline semantic tests continue to pass.
- The Windows Terminal -> WSL path no longer depends on inline
  `insert_before`/scrolling-region behavior when using the default `auto` mode.

The remaining validation gap is manual execution on native Windows and the
Windows Terminal -> PowerShell -> WSL path. Automated tests verify mode
selection and effect gating but cannot verify ConPTY's rendered scrollback.
