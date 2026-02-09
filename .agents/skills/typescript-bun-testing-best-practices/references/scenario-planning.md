# Scenario Planning for TypeScript + Bun Tests

## Purpose

Select a small, correct, and complete set of test scenarios before writing tests.

## Scenario Selection Criteria

Choose scenarios that maximize signal with minimal count:

- Critical user flows: revenue, data integrity, auth, key business actions.
- High-risk edges: validation boundaries, null/empty, malformed inputs.
- State transitions: create/update/delete, status changes, retries.
- Integration seams: DB/FS/network boundaries, adapters, serializers.
- Failure modes: timeouts, dependency errors, permission denied.
- Invariants: rules that must always hold.

De-prioritize:

- Trivial getters/setters.
- Redundant coverage across layers.
- Scenarios already covered by trusted libraries.

## Coverage Check (Quick)

- Every critical flow has at least one test.
- Each high-risk edge is covered once at the lowest reliable layer.
- Failure modes are exercised where recovery or messaging matters.
- No scenario relies on hidden global state.

## Scenario Description Template

Use one line per scenario:

- `Given <state>, When <action>, Then <observable outcome>`
- Or `Input <x>, Action <y>, Expect <z>`

Keep nouns concrete and outcomes measurable.

## Layering Heuristics

- Unit: pure logic, fast feedback, no IO.
- Integration: boundary correctness, serialization, adapters, DB/FS.
- E2E: only the minimum user journeys that prove the system works.

## Bun Test Notes

- Keep fixtures local to each test file when possible.
- Control time with fakes or injected clocks.
- Avoid real network unless the scenario is explicitly E2E.
