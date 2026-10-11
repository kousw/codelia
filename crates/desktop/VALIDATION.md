# Native desktop validation

## Saved source checkpoint

Experimental Mac-first GPUI Kit 0.7.1 shell, Rust 1.95.0, existing Codelia stdio runtime. Latest pre-publication validation is from 2026-10-07. Publication checks are recorded below. This is not a release or a completed native GUI acceptance gate.

| Check | Recorded result |
| --- | --- |
| Rust including headless GPUI | 67 passed / 0 failed / 1 optional performance probe ignored |
| Affected JS runtime/model/environment/worktree/packaging suites | 31 passed / 0 failed |
| Desktop, protocol and runtime builds | PASS; existing runtime CJS import.meta warning |
| Workspace typecheck, clippy all targets/all features, fmt, architecture | PASS |
| Dependency and version checks | PASS |
| Lint | PASS with 28 existing warnings |
| Full JS at preceding draft checkpoint | Both runs: 771 passed / 1 existing subprocess fixture failed / 2 opt-in tests skipped; isolated subprocess suite 34 passed. Not rerun after provider UX slice and not claimed green. |
| Current native OS/UI/IME/provider-connected QA | NOT VERIFIED |

Regression coverage includes fresh/resumed thread isolation; exact workspace/model identity; preflight rollback; unknown worktree outcomes without replay; exact approve/deny scope; parent Stop versus separate child cancellation; optional Changes/narrow navigation; bounded text; acknowledged current draft restart/atomic write/coalescing/Clear/quit failure; cancelled/repeated Send action identity; missing startup folder recovery; provider catalogs without auth/config/network and explicit thread-only model choice; Japanese draft/focus and shell-job exclusion from Child agents.

Real runtime integration used deterministic loopback providers and synthetic credentials. OpenAI HTTP SSE early delivery was verified; other transports remain buffered. Headless controls are not proof of native pixels, OS IME, frame latency or total process memory.

## Publication and cloud continuation

The public source excludes local build bundles, config/auth/state, logs, screenshots, private Library references, dependency caches and implementation plans. Full local historical evidence remains private. Source code is preserved; only operational documentation is generalized for publication.

The existing development bundle is checkout-dependent, not standalone/notarized distribution. Build/package on macOS with Bun and a readable checkout; the normal app automatically starts the source runtime. Test-only bundles use a separate name/identity, synthetic temporary state and loopback model. No user credentials belong in a bundle.

See [cloud handoff](../../dev-docs/specs/desktop/cloud-handoff.md) for setup and validation. Linux compilation and native GUI acceptance remain separate gates. No paid provider, real credential setup, GUI/security operation, merge or release is part of this source publication.

## Publication checks — 2026-10-11

Code bytes were validated in the saved continuation checkout and compared with an isolated publication clone. The original worktree and continuation remain unchanged. Only operational documentation is generalized; build artifacts and private records stay local.

| Check | Current result |
| --- | --- |
| Rust headless GPUI tests | 67 passed / 0 failed / 1 optional performance probe ignored |
| Workspace package build and native debug build | PASS; existing runtime CJS import.meta warning |
| All-target/all-feature clippy, Rust fmt, architecture, workspace typecheck | PASS |
| JS full suite, ordinary local fixture execution | 773 passed / 1 failed / 2 paid-provider integration tests skipped |
| Failing full-suite case | Concurrent child writes through path aliases; isolated related child suites: 34 passed / 0 failed |
| Packaging unit tests | 2 passed / 0 failed |
| Lint, dependency hygiene, version synchronization | PASS; lint has 28 warnings |
| Native visual/OS input/IME, current runtime smoke, Linux build, release packaging | NOT RUN in publication pass |

The initial sandboxed JS run had 762 passed / 12 failed / 2 skipped, including loopback EPERM and child-startup failures. The ordinary local rerun above resolves those environment failures but does not make the full suite green. No tests or implementation were changed to bypass a failure.

Secret review covered 1,146 current source/config/log/generated-resource text files, including 281 ignored/local text files, plus additional credential/entropy patterns. All 107 publication files were separately scanned from exact staged blobs; reviewed detections were dependency digests/names, source paths and synthetic test fixtures. No unresolved detections remain. No actual credentials were detected in publication candidates; reviewed hits are synthetic test credentials and fictional path fixtures. Personal local paths and private artifact references were removed from the public operational records. Auth files outside the checkout were not read. Binary contents and dependency caches were excluded from the scan and from the commit. Pattern/manual review cannot guarantee absence of all secrets.
