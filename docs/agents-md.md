# AGENTS.md

`AGENTS.md` is how you give durable project instructions to the coding agent.
Use it when you want the agent to consistently follow repo rules, coding conventions, or directory-specific guidance.

## What it is for

Good uses for `AGENTS.md`:
- coding rules the agent should follow every time
- package or directory ownership notes
- required verification steps
- links to the real source-of-truth docs for a subsystem

`AGENTS.md` is not the best place for reusable task playbooks.
For that, use a Skill instead.

## Where to put it

Most projects want a root file:

```text
<repo>/AGENTS.md
```

Add nested files only when a subtree needs extra rules:

```text
<repo>/packages/runtime/AGENTS.md
<repo>/crates/tui/AGENTS.md
```

## How Codelia uses it

At session start, Codelia loads the relevant `AGENTS.md` files from the project root toward the current working directory.
When work moves into another subtree, more specific `AGENTS.md` files can be resolved for that path.

Practical takeaway:
- put shared rules near the repo root
- put subsystem-specific rules close to the code they affect
- avoid copying the same long instructions into every directory

## What to write

Keep it concrete and operational.
Good examples:
- which tests to run after changes
- which docs/specs are authoritative
- naming conventions
- directory boundaries and ownership
- things the agent must not do

Less effective examples:
- vague team values
- duplicated README prose
- long architecture explanations that already live elsewhere

## Minimal example

```md
# Project agent notes

- Run `bun run typecheck` after changing TypeScript code.
- Keep runtime changes inside `packages/runtime`.
- Update `dev-docs/specs/ui-protocol.md` when protocol behavior changes.
- Do not edit generated files by hand.
```

## AGENTS.md vs Skills

Use `AGENTS.md` for:
- project rules
- directory-specific instructions
- always-on guidance

Use a Skill for:
- reusable workflows
- task-specific playbooks
- optional guidance loaded when relevant

## Related docs

- Skills: [`skills.md`](./skills.md)
- MCP: [`mcp.md`](./mcp.md)
- TUI basics: [`tui-basics.md`](./tui-basics.md)
