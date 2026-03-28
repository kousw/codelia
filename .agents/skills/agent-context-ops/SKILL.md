---
name: agent-context-ops
description: Maintain repository working context by keeping `AGENTS.md`, specs, plans, and related runbook-style docs aligned with the current implementation. Use when adding features, changing behavior, reconciling doc drift, or packaging reusable repository context for future agent work.
---

# Agent Context Ops

## Overview

Use this skill to keep a repository's long-lived working context accurate, navigable, and reusable.
The goal is not to rewrite all docs. The goal is to preserve the minimum set of context artifacts that future work depends on:

- `AGENTS.md` instructions and operating notes
- spec docs under `dev-docs/`, `docs/`, or equivalent design directories
- implementation plans under `plan/` or equivalent planning directories
- related runbooks, decision notes, and workflow checklists

Treat code, tests, and current repository structure as the truth source for implemented behavior.
Treat explicit roadmap or maintainer intent as the truth source for planned behavior.

## When to Use

Use this skill when you need to:

- add or refine a feature and capture the new workflow in repository docs
- update `AGENTS.md` after discovering implementation-specific rules or commands
- keep specs and plans synchronized with code changes
- separate implemented behavior from planned behavior
- turn one-off repo knowledge into reusable agent context
- audit whether repository context is stale, missing, duplicated, or misleading

Do not use this skill for purely editorial rewriting when implementation alignment is irrelevant.

## Core Principles

1. **Context is operational.** Favor instructions and facts that change how future work should proceed.
2. **Implementation beats assumption.** Verify claims against code, commands, tests, and directory structure before writing them down.
3. **Keep artifacts separated by purpose.**
   - Specs describe intended or current behavior.
   - Plans describe work sequencing, open tasks, and follow-up items.
   - `AGENTS.md` captures persistent repo rules, commands, workflow notes, and durable implementation knowledge.
4. **Update the smallest durable surface.** Do not duplicate the same guidance across many files unless multiple audiences truly need it.
5. **Mark uncertainty clearly.** If something is inferred rather than directly verified, say so.

## Workflow

### 1. Identify the Context Surface

List the context artifacts that matter for the task, for example:

- root or directory-local `AGENTS.md`
- `dev-docs/specs/*`
- `plan/*`
- `docs/*` if user-facing guidance changed
- local `RULES.md`, ADRs, or runbooks

For each artifact, note its role:

- always-on instructions
- implementation/spec reference
- temporary execution plan
- historical decision log
- operator checklist

### 2. Find the Truth Source

Before editing docs, inspect the real implementation inputs:

- source files and package boundaries
- tests and fixtures
- scripts/commands people actually run
- folder layout and current naming
- recent diffs when the task is tied to an active change

Prefer direct evidence over memory. If a claim cannot be verified locally, write it as tentative or ask for confirmation.

### 3. Classify What Changed

Sort findings into buckets:

- **Implemented now**: verified current behavior or commands
- **Planned next**: intended work not yet implemented
- **Durable repo guidance**: rules future contributors or agents should always know
- **Ephemeral task detail**: current-task notes that belong only in the active plan

Use the buckets to decide where information belongs.
Do not store temporary execution detail in `AGENTS.md`.
Do not store permanent repo rules only in a dated plan file.

### 4. Update the Right Artifact

Apply updates according to purpose:

- Update `AGENTS.md` for durable instructions, commands, conventions, pitfalls, and directory-specific guidance.
- Update spec docs for changed contracts, intended architecture, or current behavior descriptions.
- Update `plan/` for implementation sequencing, explicit follow-ups, and unresolved risks.
- Update runbooks/checklists for operational procedures.

When adding new notes, prefer concise bullets over long prose.
Include exact file paths, command names, or package names when they improve actionability.

### 5. Prevent Context Drift

Check for these failure modes:

- docs claiming future behavior as if already implemented
- commands that no longer exist or use the wrong package manager/tool
- guidance duplicated in multiple places with conflicting wording
- plan files containing knowledge that should be promoted into `AGENTS.md`
- `AGENTS.md` containing one-off task chatter that should remain in the current task record instead

Resolve the smallest number of files needed to restore a clean split.

### 6. Verify the Update

After changes:

- re-open the edited docs and confirm the intended guidance is present
- run the smallest relevant validation for the underlying change when feasible
- confirm any new commands or paths actually exist
- summarize what was updated, what was verified, and what remains intentionally unverified

## Heuristics for File Placement

### Put it in `AGENTS.md` when it is:
- a durable workflow rule
- a repository convention
- a command future agents should prefer
- a directory-specific warning or gotcha
- a stable map to important docs or code paths

### Put it in `plan/` when it is:
- tied to one implementation effort
- a checklist of remaining tasks
- a temporary exception or debt note
- a follow-up item with a target scope/date

### Plan naming guidance
- If the repository defines a plan-file naming convention in `AGENTS.md` or `RULES.md`, follow that convention exactly.
- If no local convention exists, prefer stable date-led names such as `YYYY-MM-DD-topic.md` so plans sort naturally and stay easy to scan.
- Keep names short, descriptive, and scoped to the work item rather than a vague team label.

### Put it in specs/docs when it is:
- a product or architecture contract
- a behavior description readers need outside the current task
- a design explanation that should outlive the current work session

## Output Expectations

When using this skill, produce:

- the updated context artifacts or patches
- a short explanation of why each file was updated
- the verification performed
- any context that still needs maintainer confirmation

## Success Criteria

This skill is successful when future contributors or agents can answer:

- What is implemented now?
- What is only planned?
- What repository rules must always be followed?
- Where should a new piece of knowledge be recorded?

without relying on private session memory.
