# TUI Log Component Projection Spec

## 1. Background

Current TUI log rendering mixes two patterns:

- append-only plain log lines
- ad-hoc in-place updates (for example, replacing a running line with a completed line)

This works for single cases, but it does not scale when multiple lifecycle logs need the same behavior (tool lifecycle, compaction lifecycle, run status lifecycle, etc.).

The major constraint is that TUI inline mode has two different output surfaces:

- Ratatui frame area (easy to redraw)
- Terminal scrollback insertion history (already inserted lines are effectively immutable)

Because those surfaces have different mutability constraints, per-kind special logic becomes brittle.

## 2. Goals

- Define one generic log lifecycle model for append + in-place update flows.
- Keep renderer-specific constraints out of parser event mapping.
- Preserve existing behavior for immutable log lines.
- Support graceful fallback when in-place update is impossible.

## 3. Non-goals

- Rewriting all existing log formatting in one PR.
- Changing runtime protocol event shapes in this phase.
- Introducing a persistent event store outside current in-memory app state.

## 4. Design overview

### 4.1 Core idea: state-first log components

Treat lifecycle logs as components with stable keys.

- Event stream updates component state.
- UI renders from component state projection.
- Rendering adapter decides whether an update can replace existing lines or must append a new summary line.

### 4.2 New internal concepts

```rust
struct LogComponentKey(String); // e.g. "compaction", "tool:tool_call_id", "run:run_id"

enum LogOp {
    Append { lines: Vec<LogLine> },
    Upsert { key: LogComponentKey, lines: Vec<LogLine> },
    Complete { key: LogComponentKey, lines: Vec<LogLine> },
}
```

`ParsedOutput` can carry one or more `LogOp` values instead of encoding lifecycle semantics in ad-hoc handler branches.

### 4.3 AppState tracking

Add component index tracking:

```rust
component_line_index: HashMap<LogComponentKey, usize>
```

Rules:

- `Append`: always push lines.
- `Upsert`:
  - if key exists and target line is mutable in current surface, replace in place.
  - if key missing (or not mutable), append and register key to appended line.
- `Complete`:
  - same as `Upsert`, then clear key from active component map.

### 4.4 Surface adapter behavior

Introduce a mutability check at render/apply boundary:

- Ratatui area: mutable.
- Already inserted scrollback history: immutable.

If immutable, fallback to append-only summary line.

This keeps behavior deterministic while preserving terminal history constraints.

## 5. Initial migration targets

Migrate incrementally to reduce risk.

### Phase 1

- Compaction lifecycle (`compaction_start`, `compaction_complete`)
- Keep current visible text:
  - `Compaction: running`
  - `Compaction: completed (compacted=true)` / `Compaction: skipped (compacted=false)`

### Phase 2

- Tool lifecycle is tracked with run-scoped component keys (`run:<scope>:tool:<tool_call_id>`).
- `pending_component_lines` (span map) is shared for tool and compaction lifecycle updates.
- Parser/handler contract still uses dedicated fields (`tool_call_start_id` / `tool_call_result`), with future migration path to explicit `LogOp` payloads.

### Phase 3

- Run/step lifecycle summaries (if needed) moved to same model.

## 6. Backward compatibility

- Existing parser line formatting remains valid during migration.
- Debug filtering policy remains unchanged (`Runtime`/`Rpc` only).
- Existing `LogKind` styling remains unchanged.

## 7. Testing strategy

- Unit tests for component tracking apply rules:
  - lifecycle start registers span for key
  - completion updates existing component line when available
  - completion appends fallback when active component is missing
  - tool key suffix fallback resolves latest pending component when scope differs
- Parser tests for lifecycle event mapping (`compaction_started` / `compaction_completed` flags and visible labels).
- Focused integration tests for compaction/tool lifecycle in TUI state transitions.

## 8. Rollout and risk control

- Keep feature migration behind small, reviewable PR steps.
- Migrate one lifecycle at a time (compaction first, then tool lifecycle).
- Do not remove old path until the new path is covered by tests.

## 9. Decisions (2026-03-03)

- `LogComponentKey` includes run scope and instance sequence for lifecycle streams.
  - Example: `run:<run_id>:compaction#<seq>`
  - Rationale: prevents accidental updates to older entries in repeated lifecycles.
- Phase 1 stores component spans in state (`start..end`) while currently registering single-line spans.
  - Multi-line range mutation logic is deferred until a component requires stable multi-line updates.
- Immutable-surface fallback does not append `(updated)` in normal mode.
  - Optional lightweight marker can be introduced later if readability issues are observed.
