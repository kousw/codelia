---
name: implementation-doc-drift-updater
description: Verify documentation claims against current implementation, detect drift, and update docs with evidence-based wording. Use when working on README/spec docs, when behavior has changed in code, when reviewing doc accuracy, or when docs intentionally include future plans and need explicit implemented/planned separation.
---

# Implementation Doc Drift Updater

## Overview

Audit implementation and documentation side by side, then update docs with explicit status labels so readers can distinguish what is implemented now versus planned for future work.
Use evidence from code and tests before asserting behavior in docs.

## Workflow

### 1. Set Scope and Truth Source
- Identify the target docs and implementation scope first.
- Treat running code and tests as source of truth for "implemented" claims.
- Treat roadmap/spec intentions as source of truth for "planned" claims.

Collect:
- Target doc files (`README`, `docs/specs/*`, package docs)
- Source code paths (`packages/*/src`, runtime handlers, protocol/types)
- Validation commands (`bun run typecheck`, `bun run test`, focused tests)

### 2. Build a Claim Inventory from Docs
- Extract concrete claims, not prose summaries.
- Split claims into atomic statements:
  - API/contract claims (types, fields, roles, events, return values)
  - Behavioral claims (flow, sequencing, retries, error handling)
  - Operational claims (commands, scripts, CI checks)

For each claim, capture:
- Doc location
- Claim text (short)
- Evidence location(s) in code/tests
- Current status classification (see `references/status-taxonomy.md`)

### 3. Verify Claims Against Implementation
- Confirm each claim with direct evidence:
  - Types/interfaces
  - Runtime control flow
  - Serialization/deserialization logic
  - Tests and command outputs
- Prefer exact file references over inference.
- If evidence is missing, do not promote claim to implemented.

Classification:
- `Implemented` (verified in current implementation)
- `Partial` (partially implemented or conditional)
- `Planned` (explicitly future-looking, not implemented now)
- `Stale` (docs no longer match implementation)
- `Unknown` (insufficient evidence)

### 4. Update Docs with Explicit Status Labels
- Rewrite ambiguous statements so status is unambiguous.
- Never mix implemented facts and future plans in a single untagged paragraph.
- Keep wording minimal and factual.

Apply labeling rules from `references/status-taxonomy.md`.
Use reusable snippets from `references/update-template.md`.

### 5. Validate and Report
- Re-run relevant checks after doc updates.
- Produce a short drift report:
  - What changed in docs
  - Which claims were downgraded/upgraded
  - What remains planned
  - Open uncertainties requiring maintainer decision

## Future-Implementation Safety Rules

Use these rules whenever docs may include future implementation:

1. Do not write future intent as present fact.
2. Require explicit marker for non-implemented content (`Planned` or `Proposed`).
3. Attach an evidence reference for implemented claims.
4. If uncertain, use `Unknown` and ask for maintainer confirmation instead of guessing.
5. Preserve intent, but separate "current behavior" from "target behavior."

## Output Format

When asked to perform this task, produce:
- A concise drift summary
- Updated docs (or patch)
- A claim status table (Implemented/Partial/Planned/Stale/Unknown)
- A short "Future Work" section with explicit planned markers

## References

- `references/status-taxonomy.md`
Use when classifying claims and choosing correct wording.

- `references/update-template.md`
Use when rewriting docs and generating drift reports.
