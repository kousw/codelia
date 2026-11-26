# state layer

`src/app/state/` stores long-lived TUI state models.

## Scope

- `input/`: composer buffer, cursor, history behavior.
- `log/`: render-safe log line model (`LogLine`, kinds/spans).
- `ui/`: panel/dialog/picker/composer suggestion state and pure UI logic.
  `ui/overlays.rs` defines the three overlay tiers and shared paste routing.
  Queue focus counts as an interaction overlay and allows queued dispatch when
  the other dispatch gates permit it.
- `render.rs`: render synchronization state (`RenderState`, phases, cache stats).
- `selection.rs`: side-effect-free transcript selection transitions and frame
  hit-map types.

## Rules

- Keep this layer side-effect free. Terminal and worker effect data lives in `app/effect.rs`; entry executes it.
- Live stream tracking closes through canonical events, retry/reset or terminal
  run status. The published delta protocol has no separate End event/state.
- Put cross-feature pure logic here when shared by `handlers` and `view`.
- Preserve render invariants:
  - `inserted_until <= visible_start <= visible_end <= wrapped_total`
  - `committed` is the next uninserted source position (log index + grapheme offset); row `source_end` excludes synthetic padding/continuation prefixes. The projected `inserted_until` may decrease after rewrapping.
  - Log indices remain stable until `clear_log`: append/replace are supported. Stream rendering may remove an uncommitted tail row only at the end of the log and at/after `committed`; middle rows must retain their indices. Other insertion/removal requires remapping committed positions.
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

- `stream_preview.rs` retains complete live text/reasoning segments scoped to run and attempt IDs until canonical channel handoff; retries/terminal failure/reset release tracking but retain observed display text. Keep canonical storage separate and never truncate received output to a preview tail.
