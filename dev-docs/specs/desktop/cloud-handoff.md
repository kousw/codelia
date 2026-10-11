# Native desktop cloud handoff

Status: experimental source checkpoint, 2026-10-11. Use branch `codex/desktop-gpui-continuation`; verify its commit against the publication handoff before continuing. The branch preserves the native GPUI implementation and shared runtime changes from base `93ab9ebc107cbbb6b7f87c4520a866e7765195ee`. It does not merge newer main changes.

## Setup and checks

Use Bun 1.3.9, Node >=20 and <25, Python 3, and Rust 1.95.0 with rustfmt/clippy. GPUI Kit 0.7.1 and native dependency versions are pinned in `crates/desktop/Cargo.lock`. A Nix environment can supply the tools and Linux graphics/build libraries; Linux compilation still needs verification in that environment. Do not copy Mac dependencies, binaries, auth, config or session state into the cloud checkout.

```sh
git clone --branch codex/desktop-gpui-continuation https://github.com/kousw/codelia.git
cd codelia
git rev-parse HEAD
bun install --frozen-lockfile
bun run --filter '@codelia/*' build
bun run typecheck
bun run lint
bun run check:deps
bun run check:versions
bun run test:js
bun run desktop:build
bun run desktop:test:ui
cargo +1.95.0 clippy --manifest-path crates/desktop/Cargo.toml --all-targets --all-features -- -D warnings
cargo +1.95.0 fmt --manifest-path crates/desktop/Cargo.toml --check
python3 crates/desktop/tests/check-architecture.py
```

Default tests use synthetic fixtures; paid provider tests are opt-in and unnecessary for this handoff. Local OAuth test names refer to mocked loopback callbacks, not an instruction to configure real OAuth or open a browser. The full JS suite has a remaining concurrent child-write fixture failure; record full-suite and isolated-suite results separately rather than claiming a green suite.

Linux GPUI dependencies include X11/Wayland and xkbcommon support. Resolve build errors using the pinned crate/platform versions and the actual compiler output. A successful headless build is not native visual or IME acceptance. The macOS app packaging script is for native Mach-O bundles and should not be run as Linux packaging validation.

## Runtime smoke and native follow-up

After workspace package builds, `bunx tsc -p crates/desktop/tests/tsconfig.json`, `bun crates/desktop/tests/runtime-smoke.ts`, `bun crates/desktop/tests/thread-recovery-smoke.ts`, and `bun crates/desktop/tests/worktree-smoke.ts` exercise isolated disposable workspaces and deterministic loopback providers. Inspect fixture cleanup and do not share real credentials or user state. These checks were not repeated in the publication pass.

Continue from [native GPUI scope](native-gpui.md), [product roadmap](product-roadmap.md), [draft persistence](drafts.md), [worktrees](worktrees.md), and [model selection](model-selection.md). Preserve UI/application/domain/runtime boundaries and the existing runtime task orchestration. Parent Stop leaves admitted children running; child cancellation is a separate action. Changes stays optional.

OpenAI HTTP SSE has tested early text delivery; other transports/providers remain buffered, and native streaming interaction is unverified. Restart-safe tool side-effect reconciliation, worktree lifecycle/leases, provider parity and measured performance remain incomplete. Native pixels, Japanese OS IME, narrow windows, repeated/interrupted approval/input flows, child cancellation and acknowledged draft recovery need distinct macOS validation against the newly built binary. Never treat the design concept or a stale app screenshot as current app evidence.

See [validation](../../../crates/desktop/VALIDATION.md) for the publication checks and limits. Use a separate validation bundle identity and disposable loopback state for future Mac QA; respect denied filesystem/GUI access.
