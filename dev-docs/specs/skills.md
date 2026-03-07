# Skills Spec（Discovery / Search / Context Loading）

This document defines specifications for integrating Skills (`SKILL.md`) into Codelia.
In particular, we will focus on the following two points.

- How to search/search for corresponding skills
- How to enter the context when loading the skill

---

## 0. Implementation status (as of 2026-02-08)

This spec is **Partially Implemented** (Phase 1 + Phase 2 main items have been implemented).

Implemented (added this turn):

- skills stable (schema-first): `packages/shared-types/src/skills/schema.ts`, `packages/shared-types/src/skills/index.ts`
- protocol extensions (`skills.list` / `context.inspect.include_skills`):
  `packages/protocol/src/skills.ts`, `packages/protocol/src/context.ts`
- config extension (`skills.enabled/initial/search`):
  `packages/config/src/index.ts`, `packages/runtime/src/config.ts`
- runtime discovery/search/load:
  `packages/runtime/src/skills/resolver.ts`
- tools:
  `packages/runtime/src/tools/skill-search.ts`,
  `packages/runtime/src/tools/skill-load.ts`
- Initial catalog injection:
  `packages/runtime/src/agent-factory.ts`
- RPC:
  `packages/runtime/src/rpc/skills.ts`,
  `packages/runtime/src/rpc/context.ts`
- TUI picker (search / scope / enable/disable switch):
  `crates/tui/src/handlers/command.rs`,
  `crates/tui/src/handlers/panels.rs`,
  `crates/tui/src/main.rs`
- skill name unit permissions policy (`permissions.*.skill_name`):
  `packages/config/src/index.ts`,
  `packages/runtime/src/permissions/service.ts`

---

## 1. Goals / Non-Goals

Goals:

1. Agent Skills Meets the standard progressive disclosure (light list, load text when needed)
2. Integrate skills without conflicting with existing AGENTS/context-management
3. Reduce prompt expansion even when there are a large number of skills
4. Resolve the same skill definitively for explicit specification (`$skill-name` / path specification)

Non-Goals:

1. Runtime automatically searches/obtains skills remotely
2. `.claude/skills` compatibility search
3. Have system scope (admin/system layer)
4. Finalize UI appearance and operation details (Picker UX)

---

## 2. Standard Baseline

Reference standard:

- Agent Skills Specification: `https://agentskills.io/specification`
- OpenAI Codex Skills Guide: `https://developers.openai.com/codex/skills/`

Standard requirements adopted:

1. 1 skill = 1 directory + `SKILL.md`
2. `SKILL.md` has a YAML frontmatter and requires `name` and `description`
3. First present the skill catalog (name/description/path) to the agent, and load the main text on-demand.
4. Relative path references within skill are resolved using "skill directory criteria"

---

## 3. Comparison of advanced implementation and adoption policy

### 3.1 Points adopted from codex

- Strictness of explicit mention resolution (disambiguation when name is duplicated, path takes precedence)
- Structured skill injection format (equivalent to `<skill> ... </skill>`)
- Separate management of skill search results and enable/disable

### 3.2 Points adopted from opencode

- on-demand loading with `skill` tool
- Operation that returns base directory and included file information when loading

### 3.3 codelia optimization policy (Hybrid)

1. Unify skill placement to `.agents/skills`
2. Inject only the catalog into the initial context (no text)
3. Inject skill text only when necessary using `skill_load` tool
4. Added `skill_search` tool exclusively for skill candidate search (scalable even with large number of skills)

---

## 4. Terminology and types (Planned)

```ts
export type SkillScope = "repo" | "user";

export type SkillMetadata = {
  id: string;            // canonical path hash (stable in session)
  name: string;
  description: string;
  path: string;          // absolute path to SKILL.md
  dir: string;           // skill base dir
  scope: SkillScope;
  mtimeMs: number;
};

export type SkillLoadError = {
  path: string;
  message: string;
};

export type SkillCatalog = {
  skills: SkillMetadata[];
  errors: SkillLoadError[];
  truncated: boolean;
};

export type SkillSearchResult = {
  skill: SkillMetadata;
  score: number;
  reason: "exact_name" | "exact_path" | "prefix" | "token_overlap";
};
```

Schema placement (Schema-first):

- `packages/shared-types/src/skills/schema.ts`: Zod schema
- `packages/shared-types/src/skills/index.ts`: infer type export

---

## 5. Discovery / Search specifications (Planned)

### 5.1 Search route

Starting from `workingDir`, search only the following.

Repo scope (root -> cwd ancestor chain):

1. `.agents/skills/**/SKILL.md`

User scope:

1. `~/.agents/skills/**/SKILL.md`

### 5.2 Route estimation

The search boundary of Repo is set to the same system as AGENTS.

- Preference: `CODELIA_AGENTS_ROOT`
- fallback: marker (default: `.codelia`, `.git`, `.jj`)

### 5.3 Frontmatter Verification

Required:

- `name`（1..64, `^[a-z0-9]+(-[a-z0-9]+)*$`）
- `description`（1..1024）

Recommended:

- `version`, `license`, `metadata` (string map)

Additional constraints:

- `name` must match the directory name containing `SKILL.md`
- Consecutive hyphens (`--`) and leading/trailing hyphens are not allowed.

When validation fails:

- Do not add to catalog
- recorded in `errors[]` as `SkillLoadError`

### 5.4 Duplicate resolution

- Unique key is `path` (canonical absolute)
- Keep skills with the same name (do not overwrite automatically)
- When selecting using only `name`, if there are multiple names with the same name, it is treated as ambiguous.

### 5.5 Search algorithm

`skill_search(query)` is scored in the following priority order.

1. `exact_path`
2. `exact_name`
3. `name` prefix
4. Token overlap of `name + description`

Tie-break:

1.score descending order
2. Scope priority (repo > user)
3.path ascending order

---

## 6. Context injection specification (Planned)

### 6.1 Initial injection (catalog only)

Add catalog to system prompt when session starts.

- Position: `system(base)` -> `agents_context(initial)` -> `skills_context(initial)`
- Contents: `name`, `description`, `path`, `scope` only
- Upper limit: `skills.initial.maxEntries`, `skills.initial.maxBytes`
- When the upper limit is exceeded, specify `truncated: true` and instruct to use `skill_search`.

example:

```xml
<skills_context>
<skills_usage>
  <rule>...skill usage guidance...</rule>
</skills_usage>
<skills_catalog scope="initial" truncated="false">
  <skill>
    <name>repo-review</name>
    <description>Review PR with risk-first checklist</description>
    <path>/repo/.agents/skills/repo-review/SKILL.md</path>
    <scope>repo</scope>
  </skill>
  <skill>
    <name>release-notes</name>
    <description>Draft release notes from commits</description>
    <path>/repo/.agents/skills/release-notes/SKILL.md</path>
    <scope>repo</scope>
  </skill>
</skills_catalog>
</skills_context>
```

### 6.2 on-demand loading

`skill_load` Inject the body as the execution result of tool.

- Normal ToolMessage in history
- target tool output cache
- Allow ref to be retained in subsequent compactions

example:

```xml
<skill_context name="repo-review" path="/repo/.agents/skills/repo-review/SKILL.md">
...SKILL.md full content...

Base directory: file:///repo/.agents/skills/repo-review/
Relative paths in this skill are resolved from this directory.
<skill_files>
<file>/repo/.agents/skills/repo-review/references/checklist.md</file>
<file>/repo/.agents/skills/repo-review/scripts/run.sh</file>
</skill_files>
</skill_context>
```

### 6.3 Reload suppression

Keep `loadedVersions(path -> mtimeMs)` within session.

- Avoid resending the body when requesting to reload the same `path + mtimeMs`
- Return a short reminder (read + ref information) instead

---

## 7. Tools specifications (Planned)

### 7.1 `skill_search`

input:

```ts
{ query: string; limit?: number; scope?: "repo" | "user" }
```

output:

- Top candidates (name/description/path/scope/reason/score)
- `count`, `truncated`

### 7.2 `skill_load`

input:

```ts
{ name?: string; path?: string }
```

rule:

1. If `path` exists, it has top priority
2. Solved if only `name` is unique
3. Error if `name` is ambiguous (returns candidate path)

output:

- `<skill_context>` text
- metadata: `{ skill_id, name, path, dir, mtime_ms }`

---

## 8. Permissions / Sandbox

### 8.1 skill name unit policy (Implemented, Phase 2)

- `permissions.allow` / `permissions.deny` in `tool: "skill_load"` rules
`skill_name` (exact match, lowercase kebab-case) can be used
- Evaluation order is the same as existing `deny > allow > confirm`
- `tool: "skill_load"` rules with unspecified `skill_name` still match the entire tool
- UI confirm remember if `skill_load`
Save `{ "tool": "skill_load", "skill_name": "<name>" }`

### 8.2 path safety

`skill_load` must satisfy the following.

1. Only paths registered in the catalog are resolved.
2. Don't go out of skill dir with `..` or symlink
3. File enumeration limits maximum number and maximum byte

---

## 9. Config Schema extension (Planned)

```ts
type SkillsConfig = {
  enabled?: boolean;                // default true
  initial?: {
    maxEntries?: number;            // default 200
    maxBytes?: number;              // default 32 * 1024
  };
  search?: {
    defaultLimit?: number;          // default 8
    maxLimit?: number;              // default 50
  };
};
```

Integrates with:

- `packages/config/src/index.ts`
- `packages/runtime/src/config.ts`

---

## 10. Protocol / Runtime extension (Planned)

### 10.1 protocol methods

addition:

- `skills.list` (Get catalog list from UI)

Draft:

```ts
type SkillsListParams = { cwd?: string; force_reload?: boolean };
type SkillsListResult = { skills: SkillMetadata[]; errors: SkillLoadError[] };
```

### 10.2 context.inspect

Add `include_skills?: boolean` so that you can check the current catalog status.

### 10.3 runtime state

Store the following in `RuntimeState`.

- `skillsCatalogByCwd`
- `loadedSkillVersions`

---

## 11. Package Boundaries

- `@codelia/core`:
- Does not have skill transport/search implementation
- Only use existing tool contract and context-management

- `@codelia/runtime`:
- discovery/search/load implementation
- Provided by `skill_search` / `skill_load` tool
- Applying permissions and sandboxes

- `@codelia/protocol`:
- `skills.list` type added
- `context.inspect` extension

- `@codelia/shared-types`:
- Manage stable types of skill catalog/results

---

## 12. Handling remote exploration

Codelia runtime does not automatically search/obtain remote skills.

---

## 13. Acceptance conditions

1. `.agents/skills/**/SKILL.md` under `root -> cwd` is enumerated
2. `~/.agents/skills/**/SKILL.md` is enumerated as user scope
3. If there are multiple skills with the same name, `name` alone `skill_load` will result in an ambiguity error.
4. `skill_search("release")` returns candidates based on name/description
5. `skill_load` returns `SKILL.md` body and base directory
6. You can avoid duplicate body injection by reloading the same skill.
7. You can check the catalog status with `context.inspect(include_skills=true)`
8. Skill loaded references are not broken even after compaction

---

## 14. Phase Plan

Phase 1（MVP）:

- local discovery (only `.agents/skills` of repo/user)
- `skill_search`, `skill_load`
- initial catalog injection
- `skills.list` protocol

Phase 2:

- [x] skill name unit policy (`permissions.*.skill_name`)
- [x] UI picker enhancement (search, scope display, enable/disable switching)
