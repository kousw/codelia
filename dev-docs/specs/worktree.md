# Worktree Management & Lane Migration Strategy

**Status:** `Proposed` — defines the target Git worktree architecture and migration away from legacy `tmux`-coupled `lane` orchestration. Existing `lanes/` runtime code and `lane_*` / `/lane` surfaces remain implemented until Phase 1 lands (see [`lane-multiplexer.md`](./lane-multiplexer.md)).

---

## 1. Motivation & Goals

The current `lane` design ([`packages/runtime/src/lanes/`](../../packages/runtime/src/lanes/manager.ts), [`lane-multiplexer.md`](./lane-multiplexer.md)) couples `git worktree` lifecycle to `tmux` shell spawning (`tmux new-session`, `send-keys`, `--initial-message`) and exposes five model-callable `lane_*` tools backed by a separate JSON status registry (`LaneRegistryStore`). That design now conflicts with Codelia's architecture:

- **Superseded autonomous execution**: `packages/runtime/src/subagents/` now provides structured child execution, mailbox messaging, parent-mediated approvals, and typed terminal reasons, making shell-injected `tmux` lanes redundant and weaker.
- **Cross-client & cross-OS mismatch**: `tmux` coupling leaves `zellij` unimplemented, cannot serve native Windows shells cleanly, and does not fit [`crates/desktop` / GPUI](./desktop/gpui-shell.md) (proposed).
- **Missing human-first CLI entry**: Users expect `codelia --worktree` (`-w`) to isolate an interactive session immediately without a five-tool multiplexer workflow.
- **Registry drift risk**: Duplicating worktree topology in a standalone lane registry desynchronizes from manual `git worktree` commands.

### Goals

1. Replace `lane` with a multiplexer-free, **DB-free** `WorktreeService` using `git worktree list --porcelain` as the topology truth source paired only with a lightweight per-worktree JSON file (for active-PID / `baseSha` / `createdBranch` accidental-deletion protection, with no database).
2. Decouple worktree storage and Git operations from execution callers: CLI `-w`, TUI `/worktree` via user-initiated `worktree.*` RPCs, subagent `workspace_mode: "worktree"`, and future Desktop GPUI.
3. Enforce DB-free policy inheritance: fail closed on restrictions (`protected_paths`, `readonly`), and gate permissive grants (`sandbox_mode`, `trust_project_allows`, `remembered_tool_allows`, `Auto approve`) on verified `worktreesDir` containment + live `.git` agreement.
4. Provide safe worktree setup (`.worktreeinclude` copy + trust-decoupled `worktree.setup_command`) with hardened Git execution.

---

## 2. Non-goals

- Bundling, launching, or managing `tmux`, `zellij`, or other terminal multiplexers.
- Maintaining a worktree database or secondary topology registry duplicating `git worktree list`.
- Automatically executing untrusted repository hooks, filters, or setup commands.
- Falling back silently to the shared parent workspace if an isolated worktree fails to provision.
- Evaluating untrusted repo file contents on another branch (e.g., `.codelia/config.json` or `AGENTS.md` in an external PR) — that is a general workspace trust concern identical to normal `git checkout`, not a worktree-specific mechanism.
- Building a legacy `lane` runtime migration UI or startup upgrade banner (pre-existing `~/.codelia/lanes/` and `~/.codelia/worktrees/` directories are simply left untouched on disk).

---

## 3. Worktree Model, Storage Layout, & `WorktreeService`

### 3.1 Storage location (strictly outside `storage.root` / `configDir`)

Current runtime confinement (`runtimeReadOnlyPaths()` in [`packages/runtime/src/permissions/shell-backend.ts`](../../packages/runtime/src/permissions/shell-backend.ts) and [`packages/runtime/src/sandbox/context.ts`](../../packages/runtime/src/sandbox/context.ts)) places `storage.root`, `configDir`, `cacheDir`, and `credentialsDir` into `strongerPaths` as read-only and blocks `.git` write scope over overlapping roots. Placing checkouts inside `~/.codelia/worktrees/` (where `~/.codelia` is `storage.root`) or `$XDG_STATE_HOME/codelia/worktrees/` (where `$XDG_STATE_HOME/codelia` is `storage.root`) would make managed checkouts non-writable. Opening exceptions inside `storage.root` is unsafe because credentials and policy stores sit right beside it.

Therefore, Codelia-managed worktrees must live in a **disjoint user-owned directory** outside `storage.root`, `configDir`, `cacheDir`, and `credentialsDir`, exposed via `StoragePaths.worktreesDir` in [`packages/core/src/di/storage.ts`](../../packages/core/src/di/storage.ts) and [`packages/storage/src/paths.ts`](../../packages/storage/src/paths.ts):

- **Home layout** (default): `~/.codelia-worktrees/<repo-key>/<unique-dir>/`
- **XDG layout** (`CODELIA_LAYOUT=xdg`): `$XDG_DATA_HOME/codelia/worktrees/<repo-key>/<unique-dir>/` (distinct from `$XDG_CONFIG_HOME`, `$XDG_CACHE_HOME`, and `$XDG_STATE_HOME`)

Key invariants:

- `<repo-key>` derives deterministically from the canonical common Git directory / primary checkout root (sanitized repo basename + short SHA-256 prefix).
- **`<unique-dir>` is always unique and never recycled** (e.g., `<slug>-<shortId>`): removing a worktree never lets a later worktree reuse its path and accidentally re-activate stale `projects.json` grants or mix prior `--resume` session lists.
- **Confinement boundary**: because `worktreesDir` is disjoint from both `workspaceRoot` and `TMPDIR` and managed checkouts reside at exact 2-level depth (`<worktreesDir>/<repo-key>/<unique-dir>`), confined `workspace-write` / `readonly` shells cannot forge sibling or nested checkouts inside it.
- Legacy `~/.codelia/worktrees/` directories from older `lane` releases remain outside `worktreesDir` and untouched.

### 3.2 Hardened Git invocation & `WorktreeService` operations (DB-free)

All Codelia-triggered Git provisioning, inspection, and cleanup commands execute with hardened Git config overrides (preventing repository-controlled RCE via `post-checkout` hooks, `.git/config` smudge/process filters, or `core.fsmonitor`):

- Pass explicit `-c` overrides disabling hooks (`core.hooksPath` empty / no-op), repository filters (`filter.*.smudge` / `clean` / `process` disabled), and `core.fsmonitor=false`.
- Resolve `baseRef` to an exact commit SHA (`baseSha`) once and pass `baseSha` directly to `git worktree add` (eliminating ref-movement TOCTOU).

`WorktreeService` tracks only a **lightweight per-worktree JSON file** in Codelia's user state directory (`storage.root`, outside `worktreesDir` and read-only to confined shells): one small flat JSON file per managed checkout (`{ worktreePath, baseSha, createdBranch, pid }` where `pid: number | null` is set by an active `codelia -w` session and `null` when idle or created via `worktree.create` — no database and no copied-file checksums). `list`, `remove`, and `prune` check OS process liveness on `pid` so crashed sessions do not leave permanent locks:

- `create({ workingDir, name?, baseRef?, detach?, pid? })`: validates non-empty repo/commit, sanitizes `name`, guards against branch D/F conflicts (e.g., an existing `codelia` branch blocking `codelia/<slug>`), provisions checkout at `<worktreesDir>/<repo-key>/<unique-dir>`, and writes the per-worktree JSON file (`worktreePath`, `baseSha`, `createdBranch`, `pid ?? null`).
- `list({ workingDir })`: parses `git worktree list --porcelain` (read-only) and annotates entries with exact 2-level `worktreesDir` containment, live-PID active status (checking OS process liveness when `pid !== null`), lock state, and dirtiness.
- `isClean({ worktreePath, baseSha, createdBranch })`: runs `git -c core.fsmonitor=false -c status.showUntrackedFiles=all status --porcelain` and verifies no in-progress merge/rebase/cherry-pick, `HEAD === baseSha`, and (when Codelia created a branch) `refs/heads/<createdBranch> === baseSha`. Edits to copied gitignored bootstrap files (such as `.env.local`) are intentionally not tracked because the originals remain in `parentRoot`. Fails closed (preserves worktree) on any status error or initialized submodule.
- `remove({ workingDir, target, force? })`: validates `target` is at exact 2-level `<worktreesDir>/<repo-key>/<unique-dir>`, unlocked, and not held by a live `pid` in its per-worktree JSON file (rejecting active-PID or dirty checkouts unless `--force`); removes worktree (with brief retry for OS handle settle); deletes `createdBranch` only when its tip matches `baseSha` unless `--force` (never blind `branch -D` on moved or pre-existing branches); removes the per-worktree JSON file and cleans up any stale `projects.json` key for `target`.
- `prune({ workingDir })`: wraps hardened `git worktree prune`, removes empty `<repo-key>` containers under `worktreesDir`, and deletes orphaned per-worktree JSON files whose directory no longer exists (and clears dead PIDs on remaining checkouts).

### 3.3 Branch naming, sanitization & exit behavior

- `--name` input is strictly sanitized against path separators, `..`, leading `-`, and `git check-ref-format` rules; invalid names fail fast with explicit errors. Never reuse an existing branch.
- **Proposed default (open decision in Section 7)**: Auto-create unique `codelia/<slug>-<shortId>` (supporting `--detach` for detached `HEAD`). On `codelia -w` exit, clear the active `pid`; if `isClean` holds, remove the per-worktree JSON file + worktree + `createdBranch`, otherwise preserve the worktree, branch, and metadata (without an active `pid`) and print path + branch + summary.

---

## 4. Policy Inheritance & Security Invariants

A linked worktree receives its own filesystem root (`worktreeRoot`). Treating it as an unrelated workspace would silently relax `readonly` to `workspace-write` or drop `protected_paths`. Conversely, blindly trusting `.git` links would allow privilege escalation.

### 4.1 Containment + `.git` verification (no provenance DB)

In Codelia today, confined development shells have write access inside `commonDir` ([`packages/runtime/src/permissions/git-metadata.ts`](../../packages/runtime/src/permissions/git-metadata.ts)), so a confined agent could run `git worktree add` inside `TMPDIR` to create a valid linked worktree if `.git` linkage alone granted permissions. Instead of adding a provenance database, Codelia gates inheritance on containment under `worktreesDir` + live `.git` agreement:

1. **Restrictive constraints (`protected_paths`, `readonly`, legacy `minimal -> readonly`) — fail-closed**:
   - Applied whenever a linked worktree resolves to a candidate primary repository. Tightening restrictions can never escalate privilege.
2. **Permissive grants (`sandbox_mode`, `trust_project_allows`, `remembered_tool_allows`, `full-access`, confined `Auto approve`) — strictly gated**:
   - Permitted **only** when **both** hold:
     1. **Exact 2-level `worktreesDir` containment**: `worktreeRoot` resolves to an exact `<worktreesDir>/<repo-key>/<unique-dir>` path (rejecting deeper nested subdirectories inside another worktree, and blocking confined `workspace-write` / `readonly` shells from forging checkouts in `TMPDIR` or sibling directories without a database).
     2. **Live bidirectional `.git` agreement**: `parentRoot`'s own non-symlink `.git` marker (`isSymbolicLink() === false`) and `worktreeRoot` independently resolve to the exact same canonical `commonDir` — blocking nested repos and submodules.
3. **Non-standard layouts** (bare repos, `--separate-git-dir` pointing outside `parentRoot`, `core.worktree` overrides): do not inherit permissive grants and fall back safely to defaults and confirmation (while preserving defensive restrictions).

### 4.2 Effective precedence & store mapping

Effective order inside a verified Codelia worktree:

`CLI flag / env override > SDK workspace.sandboxMode > explicit worktree entry > verified parentRoot entry > global default`

| Setting / Store | Runtime Owner | Inheritance Behavior | Security & Lifecycle Guards |
| --- | --- | --- | --- |
| `sandbox_mode` & legacy `approval_mode` (`projects.json`) | [`packages/storage/src/projects-store.ts`](../../packages/storage/src/projects-store.ts), [`packages/runtime/src/sandbox/mode.ts`](../../packages/runtime/src/sandbox/mode.ts) | Inherit `parentRoot.sandbox_mode` (or legacy `approval_mode`: `minimal -> readonly`, `trusted -> workspace-write`) unless worktree has an explicit override. | Preserve CLI/env and SDK (`environment.workspace.sandboxMode`) precedence; clean up worktree key in `projects.json` on `remove`. |
| `protected_paths` (`projects.json` + host) | [`packages/runtime/src/permissions/runtime-resource-policy.ts`](../../packages/runtime/src/permissions/runtime-resource-policy.ts) | Merge `default.protected_paths`, `parentRoot.protected_paths`, SDK `hostProtectedPaths`, and `worktree.protected_paths`, **and project every rule falling within (or equal to) `parentRoot` onto `worktreeRoot`**. | Also keep parent paths protected directly and across sibling copies; preserve ancestor rules covering `parentRoot`; avoid stale policy caching across dynamic workspace changes. |
| `trust_project_allows` & `remembered_tool_allows` (`projects.json`) | [`packages/runtime/src/local-permission-allows.ts`](../../packages/runtime/src/local-permission-allows.ts), [`packages/runtime/src/permissions/tool-approval.ts`](../../packages/runtime/src/permissions/tool-approval.ts) | Inherit whenever `worktreesDir` containment + `.git` agreement pass. | Matches the same path-trust semantics as checking out branches in `parentRoot` (content-level trust for repo files such as `.codelia/config.json` or `AGENTS.md` is separate from worktree management). Legacy `trusted` continues to carry scoped allow trust where applicable. |
| Confined `Auto approve` opt-in | [`packages/runtime/src/permissions/local-reviewer.ts`](../../packages/runtime/src/permissions/local-reviewer.ts) | Require `worktreesDir` containment + `.git` agreement + no local disable override. | Inherited Auto approve transmits commands/prompts to the configured reviewer model; surface inherited state clearly in TUI/status (see Section 7). |
| Saved shell launch rules | [`packages/runtime/src/permissions/launch-rules.ts`](../../packages/runtime/src/permissions/launch-rules.ts) | Keep bound to exact `project` + `cwd` (no cross-worktree expansion). | Preserves exact executable + `argv` + `cwd` + authority binding across separate checkouts. |

---

## 5. Worktree Setup (File Inclusion & Setup Command)

### 5.1 Local file inclusion (`.worktreeinclude` / user config)

- Copying gitignored local files (such as `.env.local`) reads `.worktreeinclude` (and/or user config) from `parentRoot` (the launching checkout, not `worktreeRoot` checked out from `baseRef`) with **explicit user-owned policy / opt-in**, and copies only matching gitignored regular files.
- **Mandatory guards**:
  1. Compute effective `protected_paths` (including projected child rules) before copying, and exclude protected paths by default.
  2. Reject symlinks escaping `parentRoot` or `worktreeRoot`, skip non-regular files, never copy `.git` or `.codelia` authority/credential internals, and never overwrite existing or tracked destination files.

### 5.2 Setup command (`worktree.setup_command`)

- **Complete decoupling from `/permissions trust`**: `/permissions trust` authorizes reviewed `permissions.allow` rules in a checkout — it never authorizes executing arbitrary startup scripts or package lifecycle scripts (`postinstall` in `baseRef`'s `package.json`, even if user global config sets `setup_command: bun install`).
- Running `worktree.setup_command` requires **dedicated explicit user confirmation** showing the resolved command, `baseSha`, and `worktreeRoot`, reusing Codelia's shell approval and execution architecture (confined by default unless explicitly approved otherwise).
- Phase 2 model-initiated subagent setup commands must stay strictly inside the child agent's delegated permission ceiling.

---

## 6. Phased Rollout & `lane` Removal

### 6.1 Phase 1 — `WorktreeService`, User RPCs, CLI `-w`, TUI `/worktree`, & `lane` Removal

1. **Core worktree & policy inheritance**:
   - Add `StoragePaths.worktreesDir` in `packages/core/src/di/storage.ts` and `packages/storage/src/paths.ts` (outside `storage.root` / `configDir` / `cacheDir`).
   - Implement DB-free `WorktreeService` (with lightweight per-worktree JSON lock/metadata file) + hardened Git wrapper in `packages/runtime`.
   - Implement Section 4 policy inheritance + `protected_paths` projection across `ProjectsPolicyStore`, `resolveRuntimeSandboxMode`, `runtimeResourcePolicy`, `local-permission-allows`, and `local-reviewer`.
   - Implement `.worktreeinclude` safe copier + consent-gated `worktree.setup_command`.
2. **Protocol & user-initiated RPCs**:
   - Declare user-initiated `worktree.list`, `worktree.create`, `worktree.remove`, and `worktree.prune` in [`packages/protocol/src/catalog.ts`](../../packages/protocol/src/catalog.ts) with capability flags (same containment/confirmation gates as CLI; never expose destructive `remove`/`prune` or setup bypasses as unguarded model tools), and regenerate `crates/protocol` via `bun run generate:protocol`.
3. **CLI & TUI surfaces**:
   - `codelia --worktree [name]` (`-w`), `--detach`, `--base <ref>`: provisions worktree with resolved `baseSha`, runs gated setup, launches TUI in `worktreeRoot`, clears the active `pid` lock on exit, and removes clean checkouts via `isClean` (or prints preserved path/branch/summary). Handle `-w --resume [id]` cleanly across preserved and new worktrees.
   - `codelia worktree list | remove [<name|path>] [--force] | prune`: standalone management CLI commands.
   - TUI `/worktree`: lightweight list/inspect/remove/prune panel backed by the `worktree.*` RPCs (usable on both local and remote SSH runtimes; no `tmux` attach).
   - Keep resume pickers worktree-scoped by default (matching `workspace_root` in [`session-store.md`](./session-store.md)), with optional sibling discovery across shared `commonDir`.

### 6.2 `lane` removal checklist

Pre-existing `~/.codelia/lanes/` and `~/.codelia/worktrees/` files on disk are left untouched (no runtime migration banner or legacy upgrade detection needed):

- **Runtime**: delete `packages/runtime/src/lanes/`, `packages/runtime/src/tools/lane.ts`, `lane_*` exports/registration in `packages/runtime/src/tools/index.ts`, lane entries in `packages/runtime/src/permissions/tool-approval.ts`, `packages/runtime/tests/lane-manager.test.ts`, and update `packages/runtime/AGENTS.md`; review nested-lane config exception in `packages/runtime/src/permissions/workspace-config-paths.ts`.
- **Protocol codegen & TUI**: replace the `lane_list` sample in `tools/protocol-codegen/src/samples/tasks.ts` with another built-in tool sample, run `bun run generate:protocol` to refresh fixtures (`packages/protocol/tests/fixtures/protocol/ui_to_runtime_request.jsonl`, `runtime_to_ui_response.jsonl`), update `crates/tui/src/app/runtime/client.rs` test expectations, and remove `/lane` handlers/panels/parser files in `crates/tui` ([`slash.rs`](../../crates/tui/src/app/handlers/command/slash.rs), `lane.rs`, panels/composer/tests).
- **CLI & scripts**: remove `CODELIA_LANE_LAUNCH_COMMAND` from code and [`scripts/setup-codelia-dev-alias.sh`](../../scripts/setup-codelia-dev-alias.sh), while **preserving** the public `--initial-message` CLI flag ([`packages/cli/src/basic-options.ts`](../../packages/cli/src/basic-options.ts)).
- **Docs & env registry**: mark `CODELIA_LANE_LAUNCH_COMMAND` as **Removed** in [`dev-docs/environment-variables.md`](../environment-variables.md) (preserving `scripts/check-docs.mjs` retired-env detection); archive [`lane-multiplexer.md`](./lane-multiplexer.md) and [`tui-lane-command-interactive.md`](./tui-lane-command-interactive.md) into `dev-docs/archive/`; update active specs ([`task-orchestration.md`](./task-orchestration.md), [`permission-model.md`](./permission-model.md), [`ui-protocol.md`](./ui-protocol.md), [`session-store.md`](./session-store.md), [`auth.md`](./auth.md), [`runtime-environment-contract.md`](./runtime-environment-contract.md), [`tui-remote-runtime-ssh.md`](./tui-remote-runtime-ssh.md), [`tui-operation-reference.md`](./tui-operation-reference.md)).

### 6.3 Phase 2 — Subagent `workspace_mode: "worktree"` & Desktop GPUI integration

1. **Align with existing task/subagent contracts**:
   - [`packages/protocol/src/task.ts`](../../packages/protocol/src/task.ts) already defines `workspace_mode: "worktree"` and `TaskInfo.worktree_path`, while [`packages/runtime/src/tasks/types.ts`](../../packages/runtime/src/tasks/types.ts) / `subagents/coordinator.ts` currently implement only `live_workspace`. Extend `workspace_mode: "worktree"` and align directly with [`task-orchestration.md`](./task-orchestration.md) `WorkspaceLease` semantics rather than introducing a second field name.
   - Enforce existing subagent lifecycle invariants: register `WorkspaceLease` before launch, reject isolated spawn (never falling back to `live_workspace`) if worktree provisioning fails, retain capacity until executor cleanup completes, keep child operations bound to parent denials and delegated permission ceiling, return `{ worktree_path, branch, base_sha, head_sha, has_changes }` (with nullable `branch` when detached), and document that shared `.git/refs` remain visible across sibling checkouts.
2. **Desktop GPUI integration**:
   - Desktop ([`desktop/gpui-shell.md`](./desktop/gpui-shell.md), proposed) consumes Phase 1 `worktree.*` RPCs directly. When Desktop adopts automatic worktree sessions / Local-to-Worktree handoff, update [`desktop/workspace-management.md`](./desktop/workspace-management.md) accordingly.

---

## 7. Open Decisions Before Phase 1 Implementation

1. **Default checkout mode**: Auto-create unique `codelia/<slug>-<shortId>` branch (+ `--detach` opt-in) vs detached `HEAD` by default (current recommendation: auto-branch default + `--detach` flag).
2. **`setup_command` execution & network boundary**: Commands such as `bun install` require network access blocked in confined shells. Decide UX between confined execution (offline cache only unless escalated) vs upfront one-shot host confirmation.
3. **Confined `Auto approve` inheritance default**: Decide between opt-in prompt on new worktree vs verified inheritance with clear UI indicator.
4. **Parent `protected_paths` vs `.worktreeinclude`**: Keep parent/default `protected_paths` excluded from copies by default (recommended) vs copy-and-keep-protected.

---

## 8. Acceptance Criteria & Verification Plan

Phase 1 implementation must verify all of the following with unit and integration tests:

- **Disjoint writable storage (Home & XDG)**: Built-in `write`/`edit` and confined shell writes succeed inside `worktreesDir` in **both** home (`~/.codelia-worktrees/...`) and XDG (`$XDG_DATA_HOME/codelia/worktrees/...`) layouts while `storage.root`, `configDir`, `credentialsDir`, and sibling worktree checkouts stay strictly protected.
- **Containment + `.git` inheritance checks**: Confined-shell-created linked worktrees outside `worktreesDir` (e.g., `TMPDIR`), spoofed `.git` files, and nested repos/submodules fail to inherit permissive grants (`trust_project_allows`, `full-access`, `Auto approve`), while restrictive `protected_paths` and `readonly` fail closed.
- **Parent `protected_paths` projection**: Parent, default, and host `protected_paths` protect corresponding files in the child worktree across symlinks, aliases, and absent files.
- **Hardened Git, `.worktreeinclude`, & setup safety**: Malicious `post-checkout` hooks, `core.fsmonitor`, and repo filters never run during `WorktreeService` operations; escaping symlinks, tracked/existing destination overwrites, and `.git`/`.codelia` copies are rejected; `setup_command` never auto-runs without dedicated consent.
- **Safe `isClean` & active-PID accidental-deletion protection**: Active-PID checkouts, dirty checkouts, locked checkouts, submodules, and committed branches (`HEAD !== baseSha` or advanced `refs/heads/<createdBranch>`) are preserved; clean checkouts remove worktree + created branch + per-worktree JSON file cleanly.
- **Clean `lane` removal**: `bun run check:docs`, `bun run check:protocol`, `bun run check:deps`, `bun run test:js`, and `bun run test:tui` pass with stale `lane_*` / `/lane` code and fixtures removed.
