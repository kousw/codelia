# Native implementation

`main` initializes platform; `app` owns GPUI entities/event pumping; `ui` renders; `application` defines common human/agent commands; `state` projects protocol; `runtime_adapter`, `transport`, `git` implement I/O. Keep command/state types independent of GPUI and I/O. Run `python3 crates/desktop/tests/check-architecture.py` from repo root. Existing Codelia subagents own execution; no second orchestrator or external control server.

`internal_call` enforces connected/active run identity and rejects Stop-pending calls. Validate action-specific arguments locally: runtime client adapters parse JSON but do not validate supplied JSON Schema. Inspector selection belongs to each workspace's state; background agent commands must not change another workspace's visible panel. Native command tests are separate in `application_tests.rs`.

`ui_tests.rs` uses real GPUI controls with no subprocess/runtime. Keep Kit imports explicit in test modules: glob imports can shadow Rust’s built-in `#[test]` macro when test support is enabled.

`assets.rs` composes Kit default component assets with only the shell missing FileDiff/X icons. An IconName existing in the catalog does not mean it is included in `Assets`. Avoid the entire icon catalog for two shell actions.

A failed Git refresh invalidates the previous snapshot. Render its explicit error instead of a clean/zero-file result or stale diff.

`launch.rs` resolves normal workspace/runtime options and optional bounded native validation resources before GPUI startup. `transport::RuntimeOptions` owns explicit child environment and optional fixture stderr log. Keep QA credentials synthetic, provider loopback-only and fixture roots temporary; invalid metadata fails closed. Do not move denied runtime source or globally mutate environment.

Worktree commands share the pure application route with codelia_app. Creation emits an asynchronous intent, not a success claim; internal intent origin is run_owner even if the human selects another thread. Runtime owns all writes and exact confirmation. Opening another checkout is an explicit user effect and runtime_adapter revalidates common Git directory before navigation.

`drafts.rs` is the pure current nonempty composer snapshot; `draft_controller.rs` coalesces and scopes actions; `draft_store.rs` owns background IO under the normal Codelia state root. Pin physical checkout identity, compare saved revision, never log text/title or restore submitted work. Normal quit waits for current drafts before runtime cleanup; failure keeps input/window open. See dev-docs/specs/desktop/drafts.md.

Startup can legitimately have no workspaces (missing/unreadable selected folder). Keep poll, input capture, Send and Quit safe until one opens, and render an actionable folder picker. Do not create/connect a placeholder runtime or silently choose another folder. QA fixture absence must not be presented as a provider/auth failure.

Native model recovery uses ChooseModel/ListModels and negotiated run.start.model; keep choices conversation-owned, catalog responses exact-request scoped, Send blocked until model-ready. Native production must not use model.set to silently write global config or another bound session. Child tasks are kind=subagent, never shell jobs.
