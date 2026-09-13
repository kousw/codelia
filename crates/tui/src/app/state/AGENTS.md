# state layer

`src/app/state/` stores long-lived TUI state models.

## Scope

- `input/`: composer buffer, cursor, history behavior.
- `log/`: render-safe log line model (`LogLine`, kinds/spans).
- `ui/`: panel/dialog/picker/composer suggestion state and pure UI logic.
- `render.rs`: render synchronization state (`RenderState`, phases, cache stats).
- `selection.rs`: side-effect-free transcript selection transitions and frame
  hit-map types.

## Rules

- Keep this layer side-effect free.
- Put cross-feature pure logic here when shared by `handlers` and `view`.
- Preserve render invariants:
  - `inserted_until <= visible_start <= visible_end <= wrapped_total`
  - `committed` is the next uninserted source position (log index + grapheme offset); row `source_end` excludes synthetic padding/continuation prefixes. The projected `inserted_until` may decrease after rewrapping.
  - Log indices remain stable until `clear_log`: append/replace are supported; adding log insertion/removal requires remapping committed positions.
- Selection projection identity is stable across highlight-only redraws;
  per-draw frame revisions are hit-map metadata, not endpoint identity.
- Wrapped transcript provenance stores one selectable fragment per source
  grapheme. Synthetic gutters, padding, and continuation prefixes have no
  fragment.
- Transcript hit testing must resolve through those fragments: reject an empty
  row for selection start, clamp horizontal synthetic cells to selectable
  boundaries, and use drag direction when crossing blank rows.

## Dependency Direction

- `state` must not import `view`, `render`, or `handlers`.
