# state layer

`src/app/state/` stores long-lived TUI state models.

## Scope

- `input/`: composer buffer, cursor, history behavior.
- `log/`: render-safe log line model (`LogLine`, kinds/spans).
- `ui/`: panel/dialog/picker/composer suggestion state and pure UI logic.
- `render.rs`: render synchronization state (`RenderState`, phases, cache stats).

## Rules

- Keep this layer side-effect free.
- Put cross-feature pure logic here when shared by `handlers` and `view`.
- Preserve render invariants:
  - `inserted_until <= visible_start <= visible_end <= wrapped_total`
  - `inserted_until` monotonic unless explicit reset.

## Dependency Direction

- `state` must not import `view`, `render`, or `handlers`.

