# Repository Audit — 2026-07-16

## Status

- Audit status: completed. The user-selected low-risk remediation scope completed on 2026-07-16 resolved 6 findings and partially remediated 4. The 2026-07-18 TUI follow-up resolved AUD-009, bringing the total to 7 resolved findings. Including the incidental AUD-029 lockfile cleanup, this document records 5 partially remediated findings in total; the remaining findings stay open.
- Baseline commit: `542fa9d7a1ed33d84f75538492805a292669a8ed`.
- Baseline branch: `main`, equal to `origin/main` when the audit started.
- This document records verified findings against the current implementation. It is not a claim that static analysis can prove the absence of every possible defect.

The following pre-existing working-tree changes were treated as draft documentation, not as implemented behavior. The later remediation edited only the stale `shell.exec` status lines in `ui-protocol.md` and preserved the other draft changes:

- `dev-docs/specs/backlog.md`
- `dev-docs/specs/task-orchestration.md`
- `dev-docs/specs/ui-protocol.md`

## Scope and method

The audit covered:

- TypeScript core, runtime, config, storage, CLI, model metadata, and protocol boundaries;
- Rust TUI rendering, input, clipboard, and runtime handshake behavior;
- sandbox and approval-policy boundaries;
- local persistence and process lifecycle;
- basic-web and Terminal-Bench tooling;
- dependencies, CI, release workflows, package contents, documentation drift, and tracked-file secrets;
- unit tests, type checks, builds, formatting/lint checks, release smoke, and selected local reproductions.

Explicitly planned/backlog features were not counted as defects unless the current public API already exposes a non-functional option or the documentation incorrectly describes implemented behavior.

## Severity

| Priority | Meaning | Count |
|---|---|---:|
| P1 | Security boundary break, data/result loss, startup failure, or process/task corruption; fix before wider use or release | 9 |
| P2 | Material reliability, privacy, protocol, test, or operational risk | 16 |
| P3 | Distribution, documentation, CI, or maintainability debt | 9 |

## P1 findings

### AUD-001 — File tools can escape the logical sandbox through symlinks

**Evidence**

- [`packages/runtime/src/sandbox/context.ts:49-65`](../../packages/runtime/src/sandbox/context.ts#L49-L65) checks only lexically resolved paths.
- [`packages/runtime/src/tools/write.ts:29-47`](../../packages/runtime/src/tools/write.ts#L29-L47) subsequently follows filesystem symlinks through normal `readFile`/`writeFile` calls.
- A local reproduction created `sandbox/link.txt -> ../outside.txt`; executing the write tool against `link.txt` overwrote `outside.txt`.

**Impact**

Read, write, edit, apply-patch, image, and other tools using the shared resolver can access files outside the configured root. A repository-controlled symlink can expose host files even in `minimal` mode.

**Recommended first action**

Canonicalize the configured root, target, and nearest existing ancestor; reject root escapes and intermediate symlinks. Use no-follow/openat-style operations where available to reduce time-of-check/time-of-use races. Add shared regression tests for every file tool.

### AUD-002 — Shell approval rules allow nested side effects without confirmation

**Evidence**

- [`packages/runtime/src/permissions/service.ts:61-105`](../../packages/runtime/src/permissions/service.ts#L61-L105) automatically allows read-oriented shell prefixes in `minimal` mode.
- [`packages/runtime/src/permissions/utils.ts:222-363`](../../packages/runtime/src/permissions/utils.ts#L222-L363) does not parse command substitution, backticks, process substitution, or redirect destinations as nested operations.
- [`packages/runtime/src/tasks/shell-executor.ts:148-163`](../../packages/runtime/src/tasks/shell-executor.ts#L148-L163) executes the approved string through a real shell.
- Local policy evaluation returned `allow` for `cat $(touch /tmp/PWNED)`, ``rg x . `touch /tmp/PWNED2` ``, and `cat /etc/hosts > /tmp/outside`.

**Impact**

Commands that appear to start with an allowed reader can execute writes or arbitrary nested commands without the confirmation promised by `minimal`/`trusted` approval modes.

**Recommended first action**

Adopt a conservative shell parser. Require confirmation for substitution, redirection, process substitution, and ambiguous syntax unless an exact full-command rule explicitly allows it. Validate redirect destinations against the path policy.

### AUD-003 — basic-web exposes unauthenticated Agent APIs on all interfaces

**Evidence**

- [`examples/basic-web/src/server/main.ts:59-68`](../../examples/basic-web/src/server/main.ts#L59-L68) enables wildcard CORS and mounts runs, sessions, and settings routes without authentication.
- [`examples/basic-web/src/server/main.ts:97-102`](../../examples/basic-web/src/server/main.ts#L97-L102) omits `hostname`; Bun defaults to `0.0.0.0`, confirmed locally.
- [`examples/basic-web/src/server/runtime/tools.ts:16-69`](../../examples/basic-web/src/server/runtime/tools.ts#L16-L69) provides a model-callable `sh -c` tool that inherits the server environment.
- [`examples/basic-web/docker-compose.yml:36-38`](../../examples/basic-web/docker-compose.yml#L36-L38) publishes the API and OAuth ports on the host.
- [`examples/basic-web/README.md:5-7`](../../examples/basic-web/README.md#L5-L7) warns that the sample is not production-ready, but the unsafe network default also affects ordinary local development.

**Impact**

A LAN client or malicious browser origin can enumerate/delete sessions, change settings, start billed runs, and induce an agent to execute shell commands with access to server credentials and files.

**Recommended first action**

Bind to `127.0.0.1` by default, loopback-bind Compose ports, remove wildcard CORS, and require authentication plus CSRF protection before any non-loopback mode. Do not expose the bash tool without OS-level isolation and a scrubbed environment.

### AUD-004 — High/critical dependency audit currently fails

**Remediation status (2026-07-16): Partially remediated.** The unused Google SDKs and their dependency graph were removed. `ws` is now an explicit `@codelia/core` dependency because release smoke proved that OpenAI's WebSocket path requires it. The audit now reports 1 critical and 6 high findings; the remaining Hono/Vite/Rollup/basic-web dependency work stays open.

**Evidence**

`bun audit --audit-level=high` reported 17 findings: 2 critical and 15 high. The graph includes `protobufjs`, `ws`, Hono, Vite, Rollup, `shell-quote`, `minimatch`, and `picomatch`.

- [`packages/core/package.json:26-34`](../../packages/core/package.json#L26-L34) declares `@google/genai` and `@google-cloud/vertexai`.
- No source file imports either package.
- [`dev-docs/specs/providers.md:6-10`](../specs/providers.md#L6-L10) confirms that the Google chat connector is not implemented.
- [`scripts/check-workspace-deps.mjs:101-132`](../../scripts/check-workspace-deps.mjs#L101-L132) only checks workspace-to-workspace dependencies and cannot detect these unused external dependencies.
- [`.github/workflows/ci.yml:17-30`](../../.github/workflows/ci.yml#L17-L30) has no dependency-audit gate.

**Impact**

Published packages install known-vulnerable dependency graphs. Exploitability differs by path: the Google graph is currently unused, Hono is used by local servers, and several findings are development-only.

**Recommended first action**

Remove the unused Google dependencies until the connector exists, update compatible Hono/Vite/runtime dependencies, regenerate the lockfile, and add a high-severity audit gate with only explicit time-bounded exceptions.

### AUD-005 — Tool-output caching destroys image and document content

**Evidence**

- [`packages/core/src/services/tool-output-cache/service.ts:22-40`](../../packages/core/src/services/tool-output-cache/service.ts#L22-L40) converts `image_url` and `document` parts to `[image]` and `[document]` strings.
- [`packages/core/src/services/tool-output-cache/service.ts:95-119`](../../packages/core/src/services/tool-output-cache/service.ts#L95-L119) returns that string as the replacement tool message.
- [`packages/runtime/src/agent-factory.ts:1033-1042`](../../packages/runtime/src/agent-factory.ts#L1033-L1042) enables the service by default.
- A fake-LLM reproduction showed that the second invocation received `caption[image]` and no data URL.

**Impact**

The model cannot inspect a client-tool image or document after the tool returns, despite the protocol supporting multipart results.

**Recommended first action**

Separate the persisted/text preview representation from the original model-facing `ContentPart[]`. Apply bounded, multimodal-aware truncation and add a regression test that inspects the next LLM invocation.

### AUD-006 — Metadata failure prevents usable static model fallback

**Evidence**

- [`packages/runtime/src/model-registry.ts:140-180`](../../packages/runtime/src/model-registry.ts#L140-L180) only reaches static fallback after successful metadata calls and does not catch availability failures.
- [`packages/model-metadata/src/sources/modeldev.ts:200-241`](../../packages/model-metadata/src/sources/modeldev.ts#L200-L241) fetches without a timeout, abort signal, or `response.ok` validation.
- A reproduction with a metadata service throwing `offline` rejected `buildModelRegistry` even though the requested model had a usable static specification.

**Impact**

An expired/missing cache plus network failure can prevent runtime startup or leave startup waiting indefinitely.

**Recommended first action**

Use a bounded timeout, catch metadata availability/parse failures, and continue with a usable static model specification. Fail only for models without required limits.

### AUD-007 — Duplicate caller-supplied task IDs corrupt active-task tracking

**Evidence**

- [`packages/runtime/src/rpc/task.ts:283-328`](../../packages/runtime/src/rpc/task.ts#L283-L328) forwards a caller-supplied `task_id`.
- [`packages/runtime/src/tasks/manager.ts:381-443`](../../packages/runtime/src/tasks/manager.ts#L381-L443) upserts the record and replaces `activeTasks` without an atomic uniqueness check.

**Impact**

Starting task B with task A's ID replaces A's record/handle. When A settles, its cleanup can delete B's state, making B impossible to query, cancel, or wait for and allowing result misattribution.

**Recommended first action**

Perform atomic create-if-absent inside the task mutation queue before process creation. Reject duplicate live IDs and add a two-concurrent-task regression test.

### AUD-008 — TUI can start a run before initialization completes

**Evidence**

- [`crates/tui/src/main.rs:47-61`](../../crates/tui/src/main.rs#L47-L61) sends initialize and immediately sends model/resume requests without tracking the initialize ID.
- [`packages/runtime/src/rpc/handlers.ts:394-440`](../../packages/runtime/src/rpc/handlers.ts#L394-L440) awaits TUI config before installing UI capabilities.
- [`packages/runtime/src/rpc/handlers.ts:756-760`](../../packages/runtime/src/rpc/handlers.ts#L756-L760) starts request handlers concurrently.
- [`crates/tui/src/app/handlers/runtime_response/mod.rs:153-164`](../../crates/tui/src/app/handlers/runtime_response/mod.rs#L153-L164) does not identify/validate the initialize response or protocol version.

**Impact**

If model/session RPC completes before initialization, an initial prompt can start before UI capabilities and startup onboarding are ready. Incompatible protocol versions are also accepted silently.

**Recommended first action**

Track an explicit initialized state and only start model/resume/initial-prompt work after successful version and capability validation.

### AUD-009 — Resolved 2026-07-18: Inline TUI dropped history in terminals 12 rows high or smaller

**Evidence**

- The bespoke zero-row insertion shortcut and custom terminal wrapper were removed.
- [`crates/tui/src/entry/terminal.rs`](../../crates/tui/src/entry/terminal.rs) now constructs Ratatui `Viewport::Inline`; [`crates/tui/src/app/render/inline.rs`](../../crates/tui/src/app/render/inline.rs) inserts prewrapped rows with `Terminal::insert_before` and advances `inserted_until` only after successful chunks.
- A `TestBackend` regression test covers a four-row inline viewport that fills the terminal, verifying that overflow reaches scrollback without changing the viewport.

**Impact**

The previous loss path is closed. Failed insertion remains retryable because the render-state boundary is not advanced before success.

**Verification**

Ratatui 0.30.2 with the `scrolling-regions` feature and Crossterm 0.29.0 compile cleanly; all 225 Rust TUI tests pass.

## P2 findings

| ID | Finding | Evidence and first action |
|---|---|---|
| AUD-010 | RPC input and output have no memory bound | [`packages/runtime/src/runtime.ts:150-169`](../../packages/runtime/src/runtime.ts#L150-L169) retains an unterminated input frame indefinitely; [`packages/runtime/src/rpc/transport.ts:80-106`](../../packages/runtime/src/rpc/transport.ts#L80-L106) logs backpressure but does not wait for drain. Add maximum frame/buffer sizes and a serialized drain-aware writer. |
| AUD-011 | Malformed RPC can become an unhandled rejection | Parsed JSON is cast directly to `RpcMessage`, while [`handlers.ts:756-766`](../../packages/runtime/src/rpc/handlers.ts#L756-L766) invokes async handlers without a catch. Validate envelopes/method params and always return JSON-RPC `INVALID_PARAMS` or `INTERNAL_ERROR`. |
| AUD-012 | OAuth loopback listener is network-visible and easy to abort | [`oauth-utils.ts:177-252`](../../packages/runtime/src/auth/oauth-utils.ts#L177-L252) omits the listen host, rejects the active flow on any wrong-state callback, and accepts `/cancel` without state. Bind loopback explicitly and ignore/reject unrelated requests without settling the active flow. |
| AUD-013 | Runtime shutdown does not close MCP processes | [`packages/runtime/src/runtime.ts:93-138`](../../packages/runtime/src/runtime.ts#L93-L138) shuts down tasks only; `McpManager.close()` is not registered. Add one idempotent shutdown path used by signal, stdin, SDK, and normal-exit paths. |
| AUD-014 | Session and tool-output files use permissive default modes | [`packages/storage/src/paths.ts:36-43`](../../packages/storage/src/paths.ts#L36-L43), [`session-state.ts:127-147`](../../packages/storage/src/session-state.ts#L127-L147), and [`tool-output-cache.ts:167-174`](../../packages/storage/src/tool-output-cache.ts#L167-L174) create `0755` directories and `0644` files under a typical `umask 022`. Use `0700`/`0600` and migrate existing files. |
| AUD-015 | Session messages and SQLite metadata are not atomically published | [`session-state.ts:428-474`](../../packages/storage/src/session-state.ts#L428-L474) renames the message file before updating SQLite. A crash can load new messages with old metadata. Store messages transactionally or publish generation files through a transactional pointer. |
| AUD-016 | Clipboard image limit is applied after large allocations | [`clipboard/mod.rs:147-170`](../../crates/tui/src/app/util/clipboard/mod.rs#L147-L170) encodes full RGBA to PNG before checking 5 MiB; WSL also builds/decodes full base64 first. Bound dimensions/raw bytes before encoding and use bounded process output. |
| AUD-017 | Combining marks and ZWJ emoji produce incorrect terminal widths | [`text/mod.rs:1-18`](../../crates/tui/src/app/util/text/mod.rs#L1-L18) forces every zero-width codepoint to width 1. Measure grapheme clusters and add combining-accent, VS16, and family-emoji tests. |
| AUD-018 | Public LLM retry options are no-ops | [`packages/core/src/agent/agent.ts:93-97`](../../packages/core/src/agent/agent.ts#L93-L97) exposes four retry options, but they are never stored or used. Implement them or remove/deprecate the public options until behavior exists. |
| AUD-019 | **Partially remediated 2026-07-16:** Terminal-Bench viewer exposes local results on the LAN | Default binding is now `127.0.0.1`, with remote access requiring explicit `CODELIA_TERMINAL_BENCH_VIEWER_HOST`; two host-resolution tests pass. Wildcard CORS remains open as a separate hardening step. |
| AUD-020 | Terminal-Bench Compose grants host-Docker-equivalent access | [`tools/terminal-bench/docker-compose.yml:7-9`](../../tools/terminal-bench/docker-compose.yml#L7-L9) mounts the real checkout read-write and `/var/run/docker.sock`. Remove the socket where possible, use a read-only source mount plus a dedicated output directory, and document any unavoidable trust boundary. |
| AUD-021 | Direct semver tag pushes bypass release verification | [`.github/workflows/publish-npm.yml:3-7`](../../.github/workflows/publish-npm.yml#L3-L7) publishes from any matching tag, while CI/smoke are only guaranteed in the separate release-tag workflow. Dispatch publish only from the verified pipeline or repeat mandatory verification in publish. |
| AUD-022 | **Resolved 2026-07-16:** Runtime shell tests wrote to the developer's real Codelia home | Shell test handlers now inject temporary session, task-registry, and tool-output stores. All 15 shell RPC tests pass with an unwritable/nonexistent HOME. |
| AUD-023 | **Partially remediated 2026-07-16:** Root CI omitted existing Terminal-Bench tests; basic-web has no tests | Root CI and `bun run test` now run the existing Terminal-Bench JavaScript suite through `bun run test:terminal-bench` (12 passing). Python/Harbor CI and basic-web tests remain open by design. |
| AUD-024 | **Resolved 2026-07-16:** Three packages did not typecheck their unit tests | Protocol, storage, and model-metadata now include `tests`; storage loads `bun-types`, and the newly exposed model-metadata mock typing error was fixed. Full workspace typecheck passes. |
| AUD-025 | **Resolved 2026-07-16:** Terminal-Bench did not forward Z.ai credentials | The Harbor adapter, Compose, example env, and README now include `ZAI_API_KEY`; an adapter regression test was added. Python syntax validation passes; executing the Harbor unit test locally still requires the optional `harbor` package. |

## P3 findings

| ID | Finding | Evidence and first action |
|---|---|---|
| AUD-026 | Dependency hygiene checker has major blind spots | [`scripts/check-workspace-deps.mjs:4-26`](../../scripts/check-workspace-deps.mjs#L4-L26) scans only `packages/`; [`:32-60`](../../scripts/check-workspace-deps.mjs#L32-L60) omits TSX/JS variants; [`:103-109`](../../scripts/check-workspace-deps.mjs#L103-L109) ignores external dependencies. Drive discovery from root workspaces and inspect all supported source extensions/dependency types. |
| AUD-027 | **Resolved 2026-07-16:** Published npm packages lacked license metadata and packaged LICENSE files | All 15 publishable manifests declare `MIT`, each package has a local `LICENSE`, and all 15 `npm pack --dry-run --json` checks include it (TUI dry-runs used `--ignore-scripts` because binaries are staged only during release). |
| AUD-028 | **Resolved 2026-07-16:** Provider, release, and protocol documentation was stale | User/internal docs now label native Z.ai, automated platform TUI publishing, and `shell.exec` as implemented; future Gemini, checksum/signature, and remote clipboard work remains planned. |
| AUD-029 | **Partially remediated 2026-07-16:** Workspace versions in `bun.lock` lag manifests | Regenerating `bun.lock` cleared the current `0.1.64`/`0.1.72` drift. Extending the version-sync checker to prevent recurrence remains open. |
| AUD-030 | Release-capable workflows use mutable action tags | CI/release/publish use tags such as `actions/checkout@v4`. Pin release-credential workflows to audited commit SHAs and automate controlled updates. |
| AUD-031 | **Resolved 2026-07-16:** Tool-output preview could split a UTF-16 surrogate pair | Preview clipping now uses grapheme boundaries, with a regression test placing an emoji across the former UTF-16 boundary. All 7 storage cache tests pass. |
| AUD-032 | Current formatting and strict-clippy checks fail but are not CI gates | `bun run check` reports 11 errors; `cargo clippy --all-targets -- -D warnings` also fails. Add separate format/check and clippy jobs after clearing the baseline. |
| AUD-033 | Several implementation files are extreme maintenance hotspots | [`RULES.md:45-59`](../../RULES.md#L45-L59) prefers focused files and review above roughly 500 lines, while `parser/helpers.rs` is 3163 lines, `parser.rs` 2470, `agent-factory.ts` 1305, and `agent.ts` 1048. Extract along transport/parsing/provider/orchestration boundaries with characterization tests. |
| AUD-034 | **Partially remediated 2026-07-16:** Successful lint/build/release checks emitted unresolved warnings | The three Biome warnings and core CJS `import.meta` warning are cleared; lint is warning-free and ESM/CJS prompt resolution was verified. The `prebuild-install` deprecation emitted by release smoke remains transitive and open. |

## Verification record

| Check | Result |
|---|---|
| `bun run lint` | Passed with 3 warnings |
| `bun run typecheck` | Passed |
| `bun run check:deps` | Passed, subject to AUD-026 |
| `bun run check:versions` | Passed, subject to AUD-029 |
| `bun run test:js` with isolated temporary HOME | 572 passed, 2 integration tests skipped |
| `bun run test:js` with the managed default HOME | 11 failures caused by AUD-022 |
| `bun run test:tui` | 228 passed |
| Terminal-Bench tests currently outside root CI | 10 JS tests passed; Python adapter test could not import uninstalled `harbor` |
| `bun run build` | Passed with CJS `import.meta` warnings |
| `bun run smoke:release` | Passed on darwin-arm64 with deprecation warnings |
| `bun audit --audit-level=high` | Failed: 2 critical, 15 high |
| `bun run check` | Failed: 11 errors, 2 warnings, 1 info |
| `cargo fmt --check` | Passed |
| `cargo clippy --all-targets -- -D warnings` | Failed on the current baseline |
| `cargo audit` | Not run; `cargo-audit` was not installed |
| Tracked-file secret scan | No high-confidence real secret found |
| Markdown relative-link scan | No broken link found |
| `git diff --check` | Passed |

## Remediation verification — 2026-07-16

| Check | Result |
|---|---|
| `bun run lint` | Passed with no warnings |
| `bun run typecheck` | Passed, including protocol/storage/model-metadata tests |
| `bun run check:deps` | Passed, subject to open AUD-026 |
| `bun run check:versions` | Passed; current lockfile workspace metadata is synchronized |
| `HOME=/tmp/codelia-full-test-home-20260716 bun run test:js` | 573 passed, 2 integration tests skipped |
| `bun run test:tui` | 228 passed |
| `bun run test:terminal-bench` | 12 passed and is now called by root CI |
| Harbor adapter Python | `py_compile` passed; unit execution unavailable because `harbor` is not installed locally |
| Core ESM/CJS build | Passed without the prior `import.meta` warning; both formats resolved `prompts/system.md` |
| Fifteen package dry-runs | Every tarball included `LICENSE`; TUI packages used `--ignore-scripts` because release binaries were not staged |
| `bun run smoke:release` | Passed on darwin-arm64; first run exposed and led to explicit `ws` ownership in core |
| `bun audit --audit-level=high` | Still fails: reduced from 2 critical/15 high to 1 critical/6 high after removing the unused Google graph and updating direct `ws` |

Additional stress result: the 15 isolated shell RPC tests pass with a nonexistent,
unwritable HOME. The full JavaScript suite still has unrelated tests that assume
HOME is writable; the normal isolated writable-HOME run above is green.

## Main integration verification — 2026-07-17

The remediation branch was merged onto `origin/main` after main advanced to
workspace version `0.1.75`. Manifest conflicts were resolved by keeping the
newer version/dependency graph together with MIT metadata, removing the unused
Google SDKs, and retaining the explicit `ws` dependency. `bun.lock` was fully
regenerated from the merged manifests.

| Check | Result |
|---|---|
| `bun run lint` / `bun run typecheck` | Passed |
| `bun run check:deps` / `bun run check:versions` | Passed |
| JavaScript package tests | 590 passed, 2 integration tests skipped |
| `bun run test:terminal-bench` | 13 passed |
| `bun run test:tui` | 228 passed |
| Core ESM/CJS build | Passed without warnings |
| Fifteen package dry-runs | Every tarball included `LICENSE` |
| `bun run smoke:release` | Passed on darwin-arm64 |

## TUI inline remediation verification — 2026-07-18

| Check | Result |
|---|---|
| `cargo fmt --manifest-path crates/tui/Cargo.toml -- --check` | Passed on the final Rust tree |
| `bun run test:tui` | 225 passed, including the full-height inline viewport scrollback regression |
| `cargo clippy --manifest-path crates/tui/Cargo.toml --all-targets -- -D warnings` | Still fails under the existing AUD-032 lint backlog; that broader cleanup remains out of scope |
| Focused stale-reference scan | No references remain to the deleted custom terminal, history insertion, or VT100 replay APIs |
| Focused high-confidence secret scan | No match found in the TUI migration files |
| `git diff --check` | Passed |

## Recommended remediation order

1. **Security boundary patch set:** AUD-001, AUD-002, AUD-003, AUD-012, remaining AUD-019 CORS hardening, AUD-020.
2. **Dependency patch set:** remaining AUD-004 advisories, AUD-026, then add audit gates.
3. **Data/result integrity patch set:** AUD-005, AUD-007, AUD-014, AUD-015.
4. **Runtime lifecycle and framing:** AUD-006, AUD-008, AUD-010, AUD-011, AUD-013.
5. **TUI robustness:** AUD-016, AUD-017.
6. **Test, release, and maintenance cleanup:** AUD-018, AUD-021, remaining AUD-023 coverage, AUD-026, AUD-029 recurrence prevention, AUD-030, AUD-032, AUD-033, and the remaining AUD-034 transitive warning.

Each implementation effort should use a separate ignored `plan/YYYY-MM-DD-*.md` file as required by the repository instructions, and should add focused regression coverage before broader refactoring.
