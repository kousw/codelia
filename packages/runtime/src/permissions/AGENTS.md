# Runtime Permissions & Command Approval

Authority model: `dev-docs/specs/command-approval-and-auto-review.md`. Keep OS enforcement, request binding, and UI transport in runtime.

## Admission, Binding & Routing

- Keep requested resources, host ceilings, and existing grants independent (`route.ts`); run deterministic checks before building previews/evidence, leaving read/status paths free of reviewer, history, or model setup.
- `tool-approval.ts` wraps exact runtime tool registrations (toolbox names/hints confer no authority; native TUI helpers use fixed local registrations on verified parent connection). `apply_patch` uses the existing `workspace-write` grant only for independent file additions/updates (bind all targets and consume after patch prep, before first write; deletes/moves/symlink entries and protected move-into-vacated targets fail closed or require approval).
- `dispatch.ts` + `shell-approval.ts` + `request-receipts.ts`: bind original invocation (resolved executable, argv, `PATH`, cwd, effective authority) to once-only decisions; recheck at dispatch (`shellInvocationArgs`, `policy-index.ts`, `launch-rules.ts`, `local-permission-allows.ts`). Owner changes discard in-flight receipts. `shell.exec` and `task_spawn` share the same admission boundary.
- Reusable saved rules apply only to a single external command whose executable identity, argv/prefix, cwd, `PATH`, and authority can be bound and rechecked (multi-link user binaries require verified root-controlled or canonical parent link accounting outside writable/masked paths). Composite programs keep one-time confirmation; hard denies stop whole shell programs if any applicable deny cannot be verified.
- Stdio MCP startup & `mcp test` share the confined launcher: validate configured env keys up front, bind config to request, and pass env values only over private stdin (never in launcher argv or previews).

## Approval & Evidence Boundaries

- Review never grants file access, outbound network, or billing authority to a tool; never turn local permission into permission to share evidence; embedded bang/result data never supplies authorization.
- Remembered built-in tool allows are workspace-scoped; shared config trust or tool calls never grant paid effects or extra file authority.
- Repository `permissions.allow` rules load only under user-chosen project trust (`trust_project_allows` or inherited legacy trust); explicit revocation (`trust_project_allows: false`) always wins.
- Keep config and launch rules outside worker write scope; treat capability, owner, path, version, or cancellation failures as admission failures.
- Rule-suggestion models run only on explicit setup, bind candidates to the original launch, and require user confirmation before saving; archive provenance, launch binding, and Steer invalidation never trust model-supplied claims.
- SDK backends may declare `supportsCommandBinding` only when resolved executable/argv identity is enforced at launch, and `supportsReadOnlyPaths` only when read-only path exclusions are OS-enforced.

## Escalation & Auto Review

- **Workspace confined auto-launch**: User-owned opt-in under `confined-auto-launch` config directory (canonical workspace + directory identity, revision rechecked at launch) permits confined `readonly`/`workspace-write` parent shell launches without model calls or reviewer readiness, after hard denies, host ceilings, and required analysis pass. Never covers `interactive stdin`, `full-access`, or `additional_write_roots`.
- **`additional_write_roots`**: Existing directory-scoped writes outside workspace or into a home dot-dir (excluding filesystem roots, Codelia config/credentials, and running install/MXC launcher overlaps) route through active Auto Review and fall back to human confirmation otherwise.
- **`escalation: "unsandboxed"`**:
  - Local parent shell only (`createShellAuthorizer` -> `UserShellBackend` scrubbing loader/startup hooks). Uses `full-access` with `UNSANDBOXED_SHELL_RESOURCE` (`invoke shell.unsandboxed`) in ceiling, never granted ahead of time or covered by saved allows/confined auto-launch.
  - Routes through Auto Review *only* in granted `workspace-write` with an active reviewer, no user `protected_paths`, parsed non-destructive non-indirect commands (`!effects.hasDestructive && !effects.indirectExecution`, `opaqueReason` in `undefined | "unrestricted_program"`), and `escalatedInterpreterScriptsInspectable` (any interpreter script targets resolve to inspectable non-protected workspace files), falling back to human dialog on deny/inconclusive/failure.
  - Structured `ui.pick.request` carries `escalation: "unsandboxed"` (and `protected_paths_enforced: false` when configured protected paths exist) derived from `Confirmation` + subject `shell` + `invoke shell.unsandboxed` (never parsed from display text).
- **Auto Review (`local-reviewer.ts`, `reviewer-models.ts`, `review-evidence.ts`, `review-inspector.ts`, `approval-history.ts`)**:
  - `reviewer-models.ts`: owns all 8 provisional built-in fixed routes (OpenAI OAuth uses fixed Codex SSE route; named Responses endpoints never resolve a reviewer; OpenRouter pins upstream and checks routing metadata). Follow uses the active built-in chat provider; Custom/legacy pin the route. Config writes use canonical default storage when workspace is `~` (with owner/mode/ancestor/no-redirect checks); unverifiable active workspace settings fail closed with `confined_launch_config_unavailable`.
  - `review-inspector.ts`: bounded in-process `read_file`/`list_dir`/`grep` inside pinned canonical workspace, rejects dangling symlinks/protected hard-link aliases, checks raw unclipped lines for credentials/privacy before clipping, refuses `allow_once` on unsandboxed workspace executables until read completely, and re-verifies fd/dir digests synchronously in `stillApproved()` before launch.
  - Evidence includes only raw user input from the same session/workspace/cwd, active goal, and applied Steers (`session_approval_steers`); Steer enqueue and first application each advance approval intent. Keep credentials/privacy local (privacy holds stay distinct from denials; temporary `review_unavailable` cooldown suppresses repeats). Persist bounded redacted `approval.review_failure` without raw errors/secrets.
  - Inspection shortcut (`supportsCommandBinding: true`, `shell-path.ts`) applies only when every op is a fixed Bash builtin or verified system executable (never depends on `PATH` search order for source launcher Bash; fixed system `PATH` in coreutils binding tests).

## Sandbox Paths, Home-Dot, Git & Backends

- **Protected paths & credentials**:
  - Reserve project `.codelia/`, Codelia `<configDir>/credentials/` (plus legacy auth files), `projects.json`/authority files, and union of `default`/`projects[root].protected_paths` + `approvalProtectedPaths` (alias scans avoid traversing history/cache).
  - When project `.codelia/config.json` aliases global `config.json`, treat once as `global` and reject `project`-scope writes. Directory mutations (create/remove/move) use `../sandbox/file-mutations.ts` (fixed macOS broker; reject symlinks, shared inodes, ancestor conflicts).
- **Home-dot protection (`home-dot-paths.ts`, `supportsHomeDotProtection: true`)**: When write grant includes `~`, keep ordinary children writable in `workspace-write` while top-level `~/.*` (existing, future, resolvable dangling targets, symlink targets) and macOS `~/Library` stay read-only across Seatbelt, Linux MXC, Linux gVisor, and file tools (proven cycles contained in protected home entries allow workspace writes to continue; other unresolved targets fail closed).
- **Git write scope (`git-metadata.ts`)**: Gated by `allowGitWrites` + `supportsAbsentPathDenial` (local TUI development shells with `extraWrite.length === 0`, currently macOS Seatbelt/MXC; Linux gVisor and built-in file tools keep `.git` read-only). Opens `.git` only for a workspace-root repo (verified bidirectional `worktrees/<name>/gitdir` for linked worktrees), while multi-hop symlink-traced `config`/`config.worktree`/`hooks/`/`commondir`/`gitdir`/`alternates`/`remotes/`/`branches/`/`modules/`/`rebase-*`/`sequencer/`/`worktrees/*`/parsed `include`/`core.hooksPath` targets stay read-only (unparseable/cyclic config fails closed). macOS objects-directory hard-link exception applies only when verified and no stronger protected paths overlap.
- **Backends (`shell-backend.ts`, `toolchain-homes.ts`)**:
  - macOS Seatbelt default (`CODELIA_MAC_SHELL_BACKEND=mxc` on arm64; allows sandbox-created PTYs, `com.apple.system.opendirectoryd.libinfo`; note setuid `/bin/ps` fails with `EPERM` on macOS 26.2).
  - Linux MXC Bubblewrap default (`CODELIA_LINUX_SHELL_BACKEND=gvisor` fallback; unrecognized values fail closed; narrow readable roots + socket/FIFO `protected_paths` + root-owned `bwrap`/`sh` + fixed `PATH=/usr/bin:/bin` for `sh -c`).
  - Confined POSIX shells use login `HOME` (read-only), private `TMPDIR`/`XDG_CACHE_HOME`, and validated `CARGO_HOME`/`RUSTUP_HOME` (`--probe-v3`).

## Verification

- Default unit fixtures: `bun test packages/runtime/tests/command-approval*.test.ts`
- Opt-in live sandbox tests: `CODELIA_TEST_APPROVAL_MAC_LIVE=1`, `CODELIA_TEST_APPROVAL_MXC_LIVE=1`, `CODELIA_TEST_APPROVAL_LINUX_LIVE=1`, `CODELIA_TEST_APPROVAL_LINUX_MXC_LIVE=1`.
