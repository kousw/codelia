# event_loop/runtime Rules

- Keep response-id based dispatch checks explicit before mutating `AppState`.
- Keep panel-building logic side-effect free where practical; mutations happen in dispatch handlers.
- Shared string/line formatting belongs in `formatters.rs` (not duplicated in dispatch paths).
- If adding new response handlers, wire them through module re-export boundaries intentionally.
