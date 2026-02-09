# AGENTS Hierarchy Loading Spec

This document defines the specifications for ``a mechanism for stably loading `AGENTS.md` in the initial context'' and ``a mechanism for resolving only the necessary amount when moving to another hierarchy during work''.
---

## 0. Definition index
The main `define` used in this spec are summarized here so that the definitions are not scattered.
### 0.1 Type definition (public)
- `AgentsConfigSchema` / `AgentsConfig`: `0.5 Minimum public schema (v1)`
- `ResolvedAgentsSchema` / `ResolvedAgents`: `0.5 Minimum public schema (v1)`
- `SystemReminderTypeSchema` / `SystemReminderType`: `0.5 Minimum public schema (v1)`
### 0.2 Runtime state (internal)
- `covered dirs`: `3. Terminology`, `5.3 covered dirs initialization`
- `loadedVersions(path -> mtimeMs)`: `6.3 Integration into context`
### 0.3 External injection (env)
- `CODELIA_AGENTS_ROOT`: `4.1 Settings`
- `CODELIA_AGENTS_MARKERS`: `4.1 Settings`
- `CODELIA_SANDBOX_ROOT` (non-target/use separation): `4.2 Root estimation algorithm`
### 0.4 `<system-reminder>` type

- `agents.resolve.paths` (Now): `11.2`
- `session.resume.diff` (Now): `11.3`
- `tool.output.trimmed` (Planned): `11.4`
- `permission.decision` (Planned): `11.5`

### 0.5 Minimum public schema (v1)
```ts
import { z } from "zod";

export const AgentsConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    root: z
      .object({
        projectRootOverride: z.string().optional(),
        markers: z.array(z.string()).optional(),
        stopAtFsRoot: z.boolean().optional(),
      })
      .optional(),
    initial: z
      .object({
        maxFiles: z.number().int().positive().optional(),
        maxBytes: z.number().int().positive().optional(),
      })
      .optional(),
    resolver: z
      .object({
        enabled: z.boolean().optional(),
        maxFilesPerResolve: z.number().int().positive().optional(),
      })
      .optional(),
  })
  .strict();

export type AgentsConfig = z.infer<typeof AgentsConfigSchema>;

export const ResolvedAgentsSchema = z
  .object({
    files: z.array(
      z
        .object({
          path: z.string(),
          mtimeMs: z.number().nonnegative(),
          sizeBytes: z.number().int().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict();

export type ResolvedAgents = z.infer<typeof ResolvedAgentsSchema>;

export const SystemReminderTypeSchema = z.enum([
  "agents.resolve.paths",
  "session.resume.diff",
  "tool.output.trimmed",
  "permission.decision",
]);

export type SystemReminderType = z.infer<typeof SystemReminderTypeSchema>;
```

### 0.6 Implementation placement (Schema-first)
- `packages/shared-types/src/agents/schema.ts`: `zod` Schema definition (sole source of definition).
- `packages/shared-types/src/agents/index.ts`: Re-export of `schema` and `z.infer` types.
- Make `Schema.parse` mandatory at the boundary (config reading/API/tool I/O) and use only `infer` type internally.
- If a product (such as JSON Schema) is required, generate it from `schema.ts` and do not increase the number of handwritten types.
---

## 1. Purpose
- Make sure to read `AGENTS.md` from the root to `cwd` for the first time.
- When the work target path changes, only the necessary ancestor `AGENTS.md` can be added and resolved.
- Reduce fluctuations in the first system message and maintain prompt cache stability.
- Prevent unnecessary reading of `AGENTS.md` every turn.
## 2. Non-purpose
- Redefining the syntax of `AGENTS.md` and the priority rules themselves (deep hierarchy priority, etc.).
- Changed skill loading specifications.
- Replacement of existing context compaction specification.
---

## 3. Terminology
- `root`: AGENTS Search base directory.
- `initial chain`: An ordered set of `AGENTS.md` in the ancestor column of `root -> cwd`.
- `covered dirs`: A set of directories that are currently treated as already AGENTS resolved.
- `resolver`: Process that resolves ancestor `AGENTS.md` from any target path and returns only unresolved or updated metadata.
---

## 4. Route estimation
### 4.1 Settings
Use `AgentsConfigSchema` / `AgentsConfig` (`0.5`) as the setting type.
External injection (optional):
- `CODELIA_AGENTS_ROOT`: Override corresponding to `projectRootOverride`.
- `CODELIA_AGENTS_MARKERS`: Comma-separated specifications corresponding to `markers`.
- These are for AGENTS resolution only and are treated independently from `CODELIA_SANDBOX_ROOT`.
### 4.2 Estimation algorithm
1. If `projectRootOverride` is specified, make it `root`.
2. If not specified, trace from `cwd` to the parent, and set the first ancestor where any of `markers` exists to `root`.
3. `root = cwd` if not found.
`markers` If not specified, the default value is `[".codelia", ".git", ".jj"]`.
Note:
- `.codelia` is treated as a project-local marker, and global settings directories such as `~/.config` are not subject to root determination.
- `projectRootOverride` is only for AGENTS search. The meaning is separated from `CODELIA_SANDBOX_ROOT`, which represents the sandbox root.
---

## 5. Initial load (session start)
### 5.1 Reading range
- Scan each directory from `root` to `cwd` from top to bottom.
- Adopt `AGENTS.md` if it exists in each directory.
- The upper limit is cut off at `initial.maxFiles` / `initial.maxBytes`.
### 5.2 Message placement
- Insert the initial AGENTS bundle as a single fixed message **immediately after the system group**.
- Example: `system(provider) -> system(environment) -> system(agents-initial) -> history...`
```xml
<agents_context scope="initial">
Instructions from: /repo/AGENTS.md
...

Instructions from: /repo/packages/foo/AGENTS.md
...
</agents_context>
```

### 5.3 covered dirs initialization
- Register the "parent directory" of each `AGENTS.md` adopted in the initial load to `covered dirs`.
- Subsequent resolvers will only return unresolved items based on this set.
---

## 6. Each time resolver (supports different hierarchy during work)
### 6.1 Trigger
- `read/edit/write` targets outside `cwd` or paths not covered by existing `covered dirs`.
- Execute `resolveAgentsForPath(targetPath)` before calling the tool.
### 6.2 Return specifications
The return type of `resolveAgentsForPath` is `ResolvedAgentsSchema` / `ResolvedAgents` (`0.5`).
Constraints:
- Do not exceed `resolver.maxFilesPerResolve` in one resolve.
- Return if `mtimeMs` has changed even in a known file.
- The resolver does not return the file body (read the body separately when necessary).
### 6.3 Inclusion in context
- resolver results are not reinjected into the ``initial system''.
- Add "candidate path only" as `<system-reminder>` to the end of the target tool results.
```xml
<system-reminder>
Additional AGENTS.md may apply for this path:
- /repo/feature/AGENTS.md (mtime: 1738970000000)
Read and apply these files before editing files in this scope.
</system-reminder>
```

- Update `covered dirs` and `loadedVersions(path -> mtimeMs)` after adding.
### 6.4 Resolver responsibility boundaries
- The resolver is responsible for "enumerating application candidates".
- Obtaining the `AGENTS.md` text and determining whether to apply it is done on the agent side (by executing `read`).
- This prevents the return size of the resolver itself from increasing.
---

## 7. Cache stability policy
- The initial `system(agents-initial)` shall remain unchanged (not regenerated) during the session.
- Add AGENTS to the tool output side (`<system-reminder>`) and do not embed the main text.
- This avoids the situation where the first message changes every turn.
---

## 8. Prompt adjustment
Add the following to the basic instructions to the model.
1. Do not search for AGENTS every turn assuming that the initial AGENTS have already been passed.
2. Use resolver only when reading/editing new target paths.
3. When necessary, `read` the path returned by the resolver and apply its contents.
4. Avoid duplicate reads on the same path.
5. If `<system-reminder type="session.resume.diff">` is present at session resume, reflect the difference first.
---

## 9. Acceptance Criteria
1. When a session starts, AGENTS of `root -> cwd` are initially injected only once in order.
2. When reading a file in another hierarchy, only the "path + mtime" of the necessary ancestor AGENTS is added with `<system-reminder>`.
3. AGENTS is not injected twice when re-reading the same layer.
4. Initial system messages do not change across turns.
5. Switching root estimation using `projectRootOverride` and `markers` works.
6. When a known `AGENTS.md` is updated (mtime changes), it is re-presented by the resolver.
---

## 10. Implementation notes (recommended)
- Place `agentsResolver` in `packages/core` and handle initial loading and resolution each time in the same implementation.
- Save the return value `mtimeMs` in `loadedVersions` and use it for update detection.
- When trimming the tool output of `docs/specs/context-management.md`, clarify the handling so that `<system-reminder>` is not missing (detailed in a separate PR).
---

## 11. `<system-reminder>` Catalog (v1)
This section defines the format of "lightweight meta-information to be additionally injected during a conversation."
### 11.1 Common rules
- Position: Added as target tool output or additional message immediately after resume.
- Principle: Only include the path / id / state difference, and do not include a huge body.
- Format: `type` Make attribute required.
```xml
<system-reminder type="...">
...
</system-reminder>
```

### 11.2 `agents.resolve.paths`（Now）

Usage:
- Notify `AGENTS.md` which is an additional application candidate for the target path.
Contents:
- `path`
- `mtimeMs`

example:
```xml
<system-reminder type="agents.resolve.paths">
Additional AGENTS.md may apply for this path:
- /repo/feature/AGENTS.md (mtime: 1738970000000)
- /repo/feature/sub/AGENTS.md (mtime: 1738971000000)
Read and apply these files before editing files in this scope.
</system-reminder>
```

### 11.3 `session.resume.diff`（Now）

Usage:
- When resuming, notify the execution context that has changed since the previous session.
Contents:
- Difference of `cwd`
- Difference of `root`
- Difference of `markers`
- `path + mtimeMs` of `AGENTS.md` requires additional confirmation
example:
```xml
<system-reminder type="session.resume.diff">
Session resumed with context changes:
- cwd: /repo/a -> /repo/b
- root: /repo -> /repo
- markers: [".codelia",".git",".jj"] -> [".codelia",".git",".jj"]
Re-check AGENTS.md for current scope:
- /repo/b/AGENTS.md (mtime: 1738973000000)
</system-reminder>
```
