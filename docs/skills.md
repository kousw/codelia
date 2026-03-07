# Skills

Skills let you package reusable workflows for the coding agent.
Use them for task-specific guidance that should be available on demand instead of being always active.

## When to use a Skill

Skills are a good fit for:
- testing workflows
- release checklists
- repo-specific refactor playbooks
- security scans
- browser automation flows

If the guidance should apply all the time for a directory, prefer `AGENTS.md` instead.

## Where Skills live

Repo-local Skills:

```text
<repo>/.agents/skills/<skill-name>/SKILL.md
```

User/global Skills:

```text
~/.agents/skills/<skill-name>/SKILL.md
```

Repo Skills are useful when a workflow belongs to one project.
User Skills are useful when you want the same workflow available across many repos.

## Naming rules

A Skill directory contains `SKILL.md` with YAML frontmatter.
The `name` should be lowercase kebab-case and match the directory name.

Example:

```text
.agents/skills/release-check/SKILL.md
```

```md
---
name: release-check
description: Run the release checklist for this repository.
---
```

## How to use Skills in the TUI

Common ways to surface Skills:
- type `/skills` in the composer to browse Skills
- mention a Skill explicitly with `$skill-name`
- ask the agent to find or load a Skill when you know the workflow but not the exact name

Codelia treats Skills as progressive disclosure:
- first it sees lightweight catalog information
- it loads the full `SKILL.md` only when needed

## What can live next to SKILL.md

A Skill can include supporting files in the same directory, for example:
- `scripts/`
- `references/`
- `assets/`

That is useful when the workflow needs helper scripts, templates, or checklists.

## Minimal example

```md
---
name: release-check
description: Run the repository release checklist.
---

# Release Check

1. Run `bun run typecheck`.
2. Run `bun run test`.
3. Summarize any failures before making changes.
```

## Skills vs AGENTS.md

Use Skills for optional workflows.
Use `AGENTS.md` for always-on project rules.

A common pattern is:
- `AGENTS.md` says which kinds of workflows matter in the repo
- Skills provide the concrete task playbooks

## Related docs

- AGENTS.md: [`agents-md.md`](./agents-md.md)
- MCP: [`mcp.md`](./mcp.md)
- TUI basics: [`tui-basics.md`](./tui-basics.md)
