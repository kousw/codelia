# Status Taxonomy for Doc Claims

Use this taxonomy when checking implementation/doc drift.

## Labels

### Implemented
- Meaning: Behavior is verifiably present in current codebase.
- Requirement: Include at least one concrete evidence reference (file path and symbol/line).
- Wording pattern:
  - "Implemented: ..."
  - "Current behavior: ..."

### Partial
- Meaning: Only part of the claim is implemented, or behavior is conditional.
- Requirement: State implemented part and missing part separately.
- Wording pattern:
  - "Partially implemented: X is present; Y is not."

### Planned
- Meaning: Intended future behavior, not currently implemented.
- Requirement: Do not use present-tense definitive wording.
- Wording pattern:
  - "Planned: ..."
  - "Not yet implemented: ..."

### Stale
- Meaning: Existing docs claim behavior that no longer matches current implementation.
- Requirement: Replace stale claim with either Implemented (corrected), Partial, or Planned.
- Wording pattern:
  - "Previous statement was outdated; current behavior is ..."

### Unknown
- Meaning: Evidence is insufficient to assert current behavior.
- Requirement: Keep explicitly unresolved and request maintainer confirmation.
- Wording pattern:
  - "Unknown: needs implementation owner confirmation."

## Prohibited Wording for Future Work

Avoid when claim is not implemented:
- "supports ..."
- "returns ..."
- "always ..."
- "guarantees ..."

Replace with:
- "planned to support ..."
- "target behavior is ..."
- "not yet implemented ..."

## Evidence Requirements

For each `Implemented` or `Partial` claim, provide:
1. Primary code evidence (`path` + symbol/line)
2. Optional test evidence (`path` + scenario)
3. Optional command evidence (`bun run test`, `bun run typecheck`, etc.)
