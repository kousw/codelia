# handlers layer

`src/app/handlers/` owns key-driven application behavior.

## Scope

- `command.rs`: thin command-entry router and stable external API for submit/queue dispatch helpers.
- `command/*`: focused command submodules (`slash`, `bang`, `prompt`, `queue`).
- `panels.rs`: panel interaction key handling.
- `image_preview.rs`: explicit TUI-local `/image` paths and non-consuming `Alt+I` composer attachment preview; no runtime call or remote path inference.
- `command/image.rs` and `runtime_response/image.rs`: capability-gated
  `/image-model` settings RPC and `/image-artifact <id>` bounded PNG transfer.
  Match pending request/artifact IDs and the captured preview intent revision
  before applying success or error responses. Keep superseded RPCs pending until
  normal response matching drains them; newer local/composer opens, reopens and
  closes must not be undone by delayed artifact replies.
  Runtime-host paths and URLs are not accepted as local artifact sources.
- `confirm.rs`: confirm lifecycle and confirm-response input handling.
- `runtime_response/*`: runtime output/RPC response application and routing (Layer 2 behavior).

## Rules

- Handlers mutate `AppState` and trigger runtime calls through `runtime/*`.
- Keep parser/formatting/presentation concerns out of handlers.
- Shared suggestion/completion logic should stay in `state/ui/*` (not duplicated here).

## Dependency Direction

- Allowed: `handlers -> state/runtime/util`.
- Avoid `handlers -> view` dependency; use `app::theme` / `app::markdown` shared modules instead.

- `/model` uses runtime-advertised provider names and named-model effort choices, with builtin fallback for older runtime responses. Empty effort arrays skip the reasoning picker. Endpoint definitions remain file-authored; existing secret prompts handle endpoint API keys.
- `/logout [provider]` sends a name only when runtime advertises `supports_scoped_logout`; never fall back to an all-provider request. Use response `session_cleared` to preserve other-provider sessions.
