# Desktop validation

`runtime-smoke.ts` starts the real runtime with `local-provider.ts`, a loopback-only deterministic Responses provider, synthetic key and isolated XDG config/state. It writes only under a new `tmp/desktop-smoke-headless-*` workspace, verifies exact lifecycle/status/file results and tears down owned processes. Never substitute real auth or enable paid provider calls. Use `bunx tsc -p crates/desktop/tests/tsconfig.json` and targeted Biome. `check-architecture.py` checks source dependency direction. Native GUI verification is separate.

The streaming probe emits real SSE text delta and holds the terminal frame until its disposable release file exists. It records the historical buffering baseline; the opted-in continuation now verifies real live text and canonical replay. The child-approval probe verifies structured task origin, continued lifetime after parent completion, exact cancellation ID and no unauthorized write. Native fixture prompts also include `native-smoke:stream` and `native-smoke:child-approval`.

The current opted-in SSE probe verifies live delivery before provider completion, then canonical replay with no transient events; a second probe cancels after actual partial text and forbids commit/final. Fixture cleanup uses stdin EOF and an owned provider self-stop marker without process-kill calls. Preserve primary test errors over cleanup failures.

worktree-smoke.ts exercises the real stdio runtime with a temporary Git repo, synthetic auth/config and no model request. It checks deny/exact confirmation/create/duplicate/missing status and dirty source preservation; cleanup uses stdin EOF. Run bun crates/desktop/tests/worktree-smoke.ts and fixture typecheck. Fixture Git commits are test-only, never user changes.

`thread-recovery-smoke.ts` uses the real runtime and synthetic loopback model with two temporary Git checkouts: fresh thread/history separation, manual resume, guarded foreign-session rejection before model work, restart unknown journal and no replay. Provider thread-probes log boolean marker presence only. Cleanup uses EOF/owned stop marker and removes only successful disposable fixtures.

Native draft tests live in draft_store.rs and ui_tests.rs. Use disposable roots/XDG state; real linked Git identities and test-only child exits before atomic rename/after committed clear reproduce restart safely. No kill call or draft content diagnostic is needed. Input coalescing, action-token cancellation/repeat, failed quit and recovered Japanese Clear use real worker/controls; native OS QA is separate.
