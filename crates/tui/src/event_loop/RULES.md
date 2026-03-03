# event_loop Rules

- Preserve behavior: no protocol/payload semantics changes during extraction refactors.
- Keep input routing order stable (dialogs/panels before main composer where applicable).
- Keep runtime response dispatch deterministic by request-id checks before side effects.
- Avoid introducing `event_loop -> view` dependency; rendering remains orchestrated in `main.rs`.
