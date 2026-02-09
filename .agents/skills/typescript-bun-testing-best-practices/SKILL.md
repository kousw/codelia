---
name: typescript-bun-testing-best-practices
description: Provide best practices for planning and writing tests in TypeScript projects that use Bun's test runner. Use when asked to design a testing strategy, review test coverage, or implement tests with Bun while keeping scenarios concise, correct, and complete.
---

# TypeScript + Bun Testing Best Practices

## Workflow

1) Gather minimal context.
- Identify system boundary, critical user flows, data sources, external dependencies, and failure impact.
- Confirm target layers: unit / integration / e2e.

2) Plan scenarios before writing tests.
- List user-visible goals and invariants first.
- Add edge cases and failure modes.
- Mark non-goals to avoid over-testing.
- Use the scenario criteria in `references/scenario-planning.md`.

3) Map scenarios to layers.
- Unit: pure logic, fast, deterministic.
- Integration: module boundaries, IO boundaries, adapters.
- E2E: critical user flows only.
- Keep a small, high-signal set per layer.

4) Specify each scenario clearly and briefly.
- Use a single-line flow: `Given / When / Then` or `Input / Action / Expected`.
- Include setup, action, assertion, and observable output.
- Avoid ambiguous steps or hidden state.

5) Implement in Bun tests.
- Prefer behavior tests over implementation detail checks.
- Structure tests with Arrange-Act-Assert.
- Keep tests deterministic: control time, randomness, and network.
- Use fixtures and helpers to reduce noise.
- Name tests as business outcomes, not functions.

6) Review with the checklist.
- Scenario coverage: critical flows + highest-risk edges.
- Scenario correctness: expected outcomes match spec.
- Redundancy: remove duplicates across layers.
- Maintainability: clear intent, minimal setup, stable assertions.

## Output Format

- Provide a short scenario plan list first.
- Then show minimal Bun test stubs or examples only if asked.
- Keep wording concise and flow-first.

## Bundled References

- `references/scenario-planning.md`: criteria for scenario selection and coverage checks.
