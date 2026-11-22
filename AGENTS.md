# Codelia

Codelia is a TypeScript Agent SDK.
It provides a runtime and a TUI.

## Basic policy

[dev-docs/typescript-architecture-spec.md](dev-docs/typescript-architecture-spec.md)

## Documentation layout

- `docs/` is reserved for user-facing documentation.
- `dev-docs/` contains developer/internal architecture notes, specs, and runbooks.
- Keep shared documentation generic. Do not include personal session contents,
  identifiers, local paths, usage counts or storage measurements without explicit approval.
- `dev-docs/specs/README.md` is the status-aware index for internal specifications;
  provider-specific contracts live under `dev-docs/specs/providers/`.
- Comparative notes against the inspected Claude Code subtree are captured in `dev-docs/claude-code-comparison.md`.

## Implementation

Specifications for each feature are written in [dev-docs/specs/](dev-docs/specs/).
The skills specification is placed in `dev-docs/specs/skills.md`.
Isolation method considerations during worker execution are organized in `dev-docs/specs/sandbox-isolation.md`.
Deferred/Backlog ideas are consolidated in `dev-docs/specs/backlog.md`.
The UI protocol (Core ⇄ UI) is located in `dev-docs/specs/ui-protocol.md` and `packages/protocol`.
Clients that resume a session must bind it with `session.open` before a session-scope `model.set`; otherwise the first `run.start` replaces that choice with the session's saved model override.
The runtime environment contract (`dev-docs/specs/runtime-environment-contract.md`) and `packages/runtime/src/environment.ts` define the MVP embedding boundary: omitted runtime options preserve TUI-local behavior, while non-TUI hosts use the side-effect-free `@codelia/runtime/sdk` entrypoint to provide explicit environment contracts and adapters.
GUI-facing management RPCs (spec: `dev-docs/specs/ui-protocol.md` 5.16+) are user actions over JSON-RPC, never model tools: `auth.status` / `auth.login` / `auth.login.complete` / `auth.login.cancel` (+ `auth.login.status` notification, pre-confirmed `auth.logout`) behind `supports_auth_management` (runtime-owned auth only; status never returns credentials; logins invalidate the cached agent via `RuntimeState.requestAgentInvalidation()`); `config.get` / `config.set` behind `supports_config_rw` (allow-listed scalar keys in `packages/runtime/src/config-keys.ts`, value origin per layer, explicit scope, idle-only writes that drop the cached agent); `permissions.list` / `permissions.remove` behind `supports_permissions_rw` (config-file allow/deny rules by structural identity, resolved approval mode read-only); `context.usage` + opt-in `run.context.usage` behind `supports_context_usage` (core `Agent.getContextUsage()`; breakdown is an estimate, used/left provider-reported); subagent `TaskSummary.progress` + opt-in `task.progress` behind `supports_task_progress` (step/phase/tool names only, in-memory, coalesced to 250 ms).
Client-provided per-run runtime tools use `run.start.tools` / `client.tool.call`; see `dev-docs/specs/ui-protocol.md` and `packages/runtime/src/tools/client.ts`. When adding a custom client tool, keep the tool definition self-sufficient for model use: describe when to prefer it, its limits, sentinel ids/update keys, and result behavior in the schema rather than relying on prompt-side hints. Client tool image results should use `ContentPart.image_url` with inline base64 data URLs and bounded payload sizes. The TUI defines its model-callable client tools in `crates/tui/src/app/runtime/client.rs`: `tui_ask_user_choice`, `tui_open_selector`, `tui_preview_artifact`, `tui_focus_context`, and `tui_show_progress`.
Built-in tools created through `defineTool` use `strict: false`, preserve Zod optional/defaulted fields as optional, and rely on runtime Zod validation. Keep model-visible descriptions concise and omit unavailable optional values instead of adding nullable-required sentinels.
Stable cross-boundary types (event/session summary, etc.) are placed in packages/shared-types.
runtime is `packages/runtime` (an IPC server that lets the UI use core/tools).
TUI is `crates/tui` (full-screen Rust client that starts runtime and renders events).
Planned desktop product specs are organized under `dev-docs/specs/desktop/`; the first shell target is Electrobun while future native shells (including GPUI in `crates/desktop`) should continue reusing runtime/protocol.
Token streaming is opt-in per client: `initialize.ui_capabilities.supports_text_delta` enables provisional `text.delta` / `reasoning.delta` agent events (`{delta, stream_id, index}`, coalesced ~40 ms, never persisted or replayed, dropped on cancel); complete `text` / `reasoning` / `final` events stay authoritative and replace all provisional text of that `stream_id` (`index` only groups provisional blocks; it does not map to complete events). See `dev-docs/specs/ui-protocol.md`. The CLI and subagent child runs do not opt in; the TUI opts in using the same published delta protocol.
Local storage layout is placed in dev-docs/specs/storage-layout.md and packages/storage.
`state.db` indexes run logs per session (`session_runs`, `dev-docs/specs/session-store.md` §2.1); `session.history` and archive cleanup read only the session's indexed logs, and a store-wide header scan runs only as the one-time backfill fallback.
Original conversation retention is specified in `dev-docs/specs/conversation-archive.md`:
`messages/` is append-only, `contexts/` is the active resume checkpoint, and optional
awaited AgentSession recording preserves originals before compaction/tool trimming.
`conversation_search` / `conversation_read` provide same-session historical evidence.
Unpinned archived/30-day-old run events are retained in gzip after diagnostic
records are removed; legacy gzip is upgraded once using a versioned header marker.
`CODELIA_SESSION_DUMP=1` dumps may expire. Preserve originals, usage and all references.
See `packages/runtime/AGENTS.md` for the runtime tool description / field describe description guide.
The CLI is expected to receive temporary fixes, so implementation priority is higher for the TUI.
The agentic-web policy (`dev-docs/specs/agentic-web.md`) separates the execution responsibility into durable-lite (API/Worker/Postgres/SSE tail) while retaining the basic-web UI.
OAuth only allows loopback callback for `dev-local`, and `prod` assumes public callback + `oauth_state` DB management (consistent with `dev-docs/specs/auth.md`).
Lane-based multi-task orchestration with `worktree` + multiplexer (`tmux`/`zellij`) is specified in `dev-docs/specs/lane-multiplexer.md`.
Runtime task/subagent orchestration is specified in `dev-docs/specs/task-orchestration.md`: the shell substrate and fresh shared-workspace depth-one subagents are implemented. Lineage, session-owned lifetime, configurable concurrency, step limits, optional execution deadlines, and delegated tool caps are enforced; aggregate token/cost enforcement, recursive children, and worktree leases remain planned. Shared writing and parent/child/sibling communication are implemented per `dev-docs/specs/subagent-collaboration.md`: read-write is the default, parents supply required, freely chosen agent names that persist separately from work labels (task_id remains the routing key), edit/write require content hashes and execute through a parent-owned check/write queue, shell executes through the owning parent, and incoming messages join at Agent step/final boundaries. First-party implementation research for Codex, Claude Code, Gemini CLI, Qwen Code, OpenCode, and Grok Build is recorded in `dev-docs/comparisons/subagent-implementations.md`.
Subagent concurrency defaults to 8 via `subagent.max_concurrent` (1–16, project overrides global). Lifetime spawns are not capped; omitted `timeout_seconds` means no execution deadline. The independent parent wait remains bounded to 120 seconds without stopping the child.
Subagent model selection supports `subagent.profiles`/`default_profile` configuration and per-spawn `profile` or `model` overrides. Explicit selection wins over configured default, then the full parent model is inherited. Profile context is supplied to the parent; admission adds no model/auth network probes.
Phase 3 bootstrap (section 9.2), typed terminal reasons (8.3), and session-owned children across parent turns (7.7.1) are implemented in `packages/runtime/src/subagents`. Parent-turn stop leaves admitted children running; `task_cancel` / `task_cancel_all` and runtime shutdown are separate. Local process execution is macOS/Linux-only; custom environments require an explicit executor factory.
SSH remote runtime mode for TUI (including local-clipboard broker request design) is specified in `dev-docs/specs/tui-remote-runtime-ssh.md`.
TUI `!` bang shell execution mode (deferred `<shell_result>` injection and shell/cache policy) is specified in `dev-docs/specs/tui-bang-shell-mode.md`.
Per-request LLM diagnostics scope (usage/cost summary vs diagnostics detail, including cache-hit semantics) is specified in `dev-docs/specs/llm-call-diagnostics.md`.
Observed streaming TPS uses optional `ChatInvokeCompletion.timing` / `llm.response.output.timing` and normal-mode `run.metrics`. TUI shows the latest completed call's rate; never substitute request latency or chunk/character counts for missing generation timing/usage. See diagnostics spec section 4.2 for reasoning/buffering limits.
Provider additions and transport changes must verify normalized usage plus timing through runtime `buildRunMetrics`, including reasoning and tool turns; extend `packages/runtime/tests/provider-metrics.test.ts` or the provider-specific metrics fixtures. TUI retains last known TPS and context until replacement measurements arrive; call/turn starts and unavailable metrics do not erase them.
Cross-provider retry, overload/rate-limit classification, bounded retry windows, retry progress, and provider-error redaction are specified in `dev-docs/specs/providers/retry-and-failures.md`; the common Agent model-step policy is implemented, while first-byte/stream-idle watchdogs and remaining buffered-delivery guards keep AUD-035 partially open. The retry window limits waits and whether another attempt may start; it must not abort an active provider request, whose connect/request/stream-idle timeouts belong to the provider transport.
Tool admission and local execution are documented in
`dev-docs/specs/command-approval-and-auto-review.md`. Runtime uses exact tool
registrations, one-use shell admission, and structured confirmation. The
sandbox modes are `readonly|workspace-write|full-access`, independent of command approval. Explicit new full access uses the OS user account. Legacy trusted maps to workspace-write and carries forward trust in shared project allows at its original scope. A new workspace may opt in with `/permissions trust`; `/permissions untrust` overrides inherited trust.
Confined shell execution selects Seatbelt on macOS or qualification-tested gVisor on Linux. Windows native MXC remains under evaluation. The runtime checks
the requested profile and resolved invocation before approval and dispatch.
See `packages/runtime/src/permissions/AGENTS.md` for platform and verification details.
Follow the [portable product defaults](RULES.md#portable-product-defaults) when changing command discovery, saved shell permissions or default file visibility.
macOS arm64 can opt into the packaged MXC launcher with `CODELIA_MAC_SHELL_BACKEND=mxc`; the default uses direct Seatbelt. Native helper ownership and tests are documented in `crates/mxc-launcher/AGENTS.md`.
Desktop clients use `supports_sandbox_mode_management`, `sandbox.get` and
`sandbox.set` for an idle, workspace-scoped change. Keep requested and applied
modes distinct. See UI protocol §5.23.
Local TUI Auto approve is off by default. User-owned `auto-review.json` v3
selects the route. Use the selected provider’s existing authentication and bind each pending decision
to its request, destination and credential scope. The bounded packet contains
the shell invocation, effective authority, current user intent and applied steers. See
`docs/command-approval.md` for setup and send limits.
Image generation is implemented in `dev-docs/specs/image-generation.md` sections 1.1-1.3: `/image-model`, `off|builtin|custom`, OpenAI/OpenRouter/Google API-key adapters, Codex OAuth builtin, immutable PNG/JPEG originals, reference-backed model input, edit/inspect/export tools and `/image-artifact` preview. Builtin follows the OpenAI chat auth: OAuth uses the fixed Codex image backend with existing token refresh/account routing and defaults to `gpt-image-2`; API-key chat uses the public Image API. A user-approved OAuth generation/save/reload/model-input smoke passed on 2026-09-13; effective model is unreported and Codex Sunburst/Flare execution remains unverified. Hosted/native output, stored auth v2 migration and retention/GC remain planned. Custom environment keys coexist with stored chat OAuth without changing auth.json. External capabilities and pinned Codex research live in `dev-docs/specs/providers/image-generation.md`. No silent auth/model/endpoint/billing fallback.
Image history transport uses fixed JPEG quality-90 4:4:4 model views for newly admitted generated opaque images; originals remain the generation/edit/export source, attachments and transparency remain original, and legacy history refs are never upgraded in place. See image-generation spec section 1.5. Healthy OpenAI WebSockets survive long tool waits. Close 1009 resets the WS chain and falls back to full-history HTTP in `auto` mode; `on` mode returns a non-retryable size failure without HTTP fallback. Neither mode resends the same payload over WS.
Production local image preview is specified in `dev-docs/specs/tui-image-preview.md`: `/image [local-path]`, `Alt+I` for composer attachments and explicit `/image-artifact <id>` RPC transfer, bounded off-thread decoding/encoding, query-free halfblocks by default, and explicit Kitty only in alternate mode outside multiplexers with OS cell metrics. Graphics stay out of durable/native transcript history; runtime dialogs preempt the preview. Automatic generated-image preview remains planned. The separate `crates/tui/examples/image-preview` lab (`image-preview` feature) retains broader protocol experiments; native visual acceptance remains manual.
Terminal-Bench support requirements (Harbor integration + headless benchmark mode + ATIF artifacts/validation) are specified in `dev-docs/specs/terminal-bench.md`.
Future built-in tool candidates (`apply_patch`, `request_user_input`, `webfetch`, `view_image`, `lsp`, MCP resource tools) are tracked in `dev-docs/specs/future-tools.md`.
Native Z.ai GLM-5.2 provider behavior is specified in `dev-docs/specs/providers/zai-provider.md` and implemented through core `ChatZai` plus runtime `model.provider=zai`.
Native Moonshot Kimi K3 provider behavior is specified in `dev-docs/specs/providers/moonshot-provider.md` and implemented through core `ChatMoonshot` plus runtime `model.provider=moonshot`.
Native xAI Grok 4.5 provider behavior is specified in `dev-docs/specs/providers/xai-provider.md` and implemented through core `ChatXai` plus runtime `model.provider=xai`.
Anthropic Claude Opus 5 uses the existing native `ChatAnthropic` path with model ID `claude-opus-5`, adaptive thinking across `low|medium|high|xhigh|max`, and Claude API fast mode; its static model contract lives in `packages/core/src/models/anthropic.ts`.
The GPT-6.1 Sol, GPT-6 Sol/Luna and Claude Fable 5.1/Opus 5.5/Sonnet 5 static model contracts are in `packages/core/src/models/`; native reasoning profiles are in `packages/runtime/src/model-reasoning.ts`. GPT-6.1 Sol supports native `low|medium|high|xhigh|max` effort and OpenAI Fast mode, with normal input capped at 270K. Only Claude Opus 5.5 among these Claude additions supports Claude API fast mode.

## Implementation plan

The implementation plan is available at [plan/](plan/).


## Rules

- When implementing, please create an implementation plan in [plan/](plan/) and update it whenever there is a change. (Name the file like 2026-01-18-agent-name.md)
- Do not commit the implementation plan file under plan/.
- Once implementation is complete, please add any important information to AGENTS.md.
- Prepare AGENTS.md in each function's directory, and add any information you need to know about that function.
- Please write coding rules and rules related to project design in RULES.md. (Please prepare it in the required directory like AGENTS.md.)

## Naming

- In new implementations, use `codelia`-prefixed identifiers for package scope / CLI name / configuration directory.

## Development Environment

TypeScript version: 5.9.3 (workspace devDependency)
Bun version: 1.4.4 (packageManager in root `package.json`)

Development API keys are managed in Infisical. Use the repository-local `codelia-infisical` skill (`.agents/skills/codelia-infisical/SKILL.md`) before running commands that need development keys. Inject them with `infisical run --env=dev -- <command>` using the configured environment/folder; keep `.infisical.yaml` ignored. Infisical owns the current key inventory, and live API tests still require explicit `INTEGRATION=1`.

## Version Control

Git is required.

- `.git` is always present.
- Basic operations: `git status`, `git log`, `git commit`
- Push to GitHub with `git push`.

## Testing / CI

- JS unit tests run with `bun test packages/*/tests`; full local test entry is `bun run test` (includes TUI tests).
- Image URL transport honors trusted host HTTP(S) proxy variables via per-request agents; direct/NO_PROXY routes retain public-IP DNS validation. Proxied destination access is enforced by the proxy. See `packages/runtime/src/image-generation/AGENTS.md` for runtime requirements and isolated Bun/Node fixture coverage.
- Terminal-Bench JS tests run with `bun run test:terminal-bench` and are part of root CI.
- Manual smoke/integration runs are opt-in via `INTEGRATION=1`.
- GitHub Actions runs lint, typecheck, and tests on push/PR.
- GitHub Actions includes dependency hygiene check (`bun run check:deps`) for workspace deps and deep-import violations.
- Workspace package version sync check is enforced by `bun run check:versions`.
- After changing or regenerating `bun.lock`, invalidate earlier lint results: run `bun install --frozen-lockfile`, then rerun `bun run lint` on the final tree before push or merge.
- Release smoke check (`bun run smoke:release`) validates `npm pack -> npm install -> CLI smoke` and runs in `.github/workflows/release-smoke.yml` on Linux/macOS/Windows.
- npm publish workflow is `.github/workflows/publish-npm.yml` (`workflow_dispatch`, supports `dist_tag` and `dry_run`).
- npm CI publishes the CLI under a per-release staging tag, then promotes the
  requested dist-tag after a clean public-registry install and CLI version check.
- Every publishable npm package must declare `license: MIT` and carry a package-local `LICENSE` so `npm pack` includes the license text.

## Utilities

- scripts/load-env.sh loads a .env file into the current shell when sourced: `source scripts/load-env.sh [path]`. Development API keys must instead be injected through Infisical as described above.

## Skills

- For testing tasks, use `typescript-bun-testing-best-practices` (linked under `.claude/skills`, source in `.agents/skills`).
- For repository-context maintenance across `AGENTS.md`, specs, and `plan/`, use `agent-context-ops` (source in `.agents/skills/agent-context-ops`).
- For execution with development API keys, use `codelia-infisical` (source in `.agents/skills/codelia-infisical`).

## Commands

- Use `bun run <script>` for project scripts (test/lint/fmt/check) to avoid ambiguity with built-in `bun` commands.
- Local verification (quick): `bun run fmt`, `bun run typecheck` (`bun run check` is optional if you want one-shot Biome checks).
- Dependency hygiene: `bun run check:deps`.
- Workspace version sync: `bun run sync:versions` / `bun run check:versions`.
- TUI binary staging for platform packages: `bun run tui:stage [-- --platform <platform> --arch <arch> --source <path>]`.
- npm publish runbook: `dev-docs/npm-publish.md` (manual release order + smoke check).
- Bang shell mode phase 1 is implemented through `shell.exec` (runtime) and deferred `<shell_result>` injection in TUI.
- Terminal-Bench subset rerun helper: `node tools/terminal-bench/scripts/rerun-subset.mjs --job <jobDir> --scope <failed|timeout|error> [--execute]`.
- Terminal-Bench JS tests: `bun run test:terminal-bench`.
- Terminal-Bench viewer: `bun run terminal-bench:viewer` (`tools/terminal-bench-viewer`, local config via `config.local.json`).

Named HTTP Responses endpoints are registered in `providers.<name>` config; see `docs/responses-providers.md` and `dev-docs/specs/providers/responses-endpoints.md`. Endpoint names own separate auth/model identities; config limits drive startup, TUI selection, compaction and child bootstrap without models.dev discovery. SDK retries stay off; endpoint retry policy controls Agent retries, and successful streams are never replayed automatically.

OpenAI chat OAuth retains the existing Codex backend (including device-code and image paths). The fixed Codex HTTP endpoint consumes raw official-SDK SSE through Codelia's existing response accumulator to tolerate extension events such as `response.metadata`; public OpenAI API and xAI retain the SDK stream helper. Require terminal responses and preserve cancellation. The separate new SIWC/public-API registration flow is not implemented or silently substituted; see `dev-docs/specs/providers/openai-websocket-mode-experimental.md`.

Selected Codex metadata semantics are implemented in `dev-docs/specs/providers/codex-backend-metadata.md`: run-scoped sticky routing, actual server model diagnostics and verification/buffering display events. Opaque routing/moderation data stays out of history/logs; no metadata-driven automatic model/auth switching or request replay.

`/logout [provider]` supports one named endpoint/builtin provider or all saved credentials when omitted. Scoped logout preserves other-provider sessions. TUI checks `supports_scoped_logout`; embedded hosts need an explicit `clearProviderAuth` adapter and never fall back to all-provider removal.


October 2026 model additions: Grok 4.7, Kimi K3.1 Pro/Highspeed and GLM-5.3 are
selectable; existing provider defaults remain unchanged. Reasoning is model-specific
in `packages/runtime/src/model-reasoning.ts`. Explicit `model.fast: "ultrafast"`
(`/fast ultrafast`) requests the OpenAI tier for supported Astra/Sol models
over the existing API-key or Codex OAuth route. OpenAI determines account
eligibility. See `dev-docs/specs/model-parameter-ui.md`
section 7. Native Gemini chat and custom image generation use the Google
Interactions API through `@google/genai` 2.32.0 with explicit `store=false`.
Native chat offers `gemini-4-hydrogen` (Google default and Auto approve),
`gemini-4-carbon`, and `gemini-4-argon`; image models are `gemini-nano-banana-2.1`,
`gemini-3.1-flash-lite-image`, and `gemini-3-pro-image`. Google custom images
preserve returned PNG/JPEG originals and support 1K/2K/4K where documented.
The shared artifact ceiling is 32 MiB, 12288px per side and 20 MP. The adapters
are SDK-fixture-tested; after Prepay funding on 2026-11-02, stateless chat,
function-call replay, 1K Flash Lite and 4K Nano Banana 2.1 JPEG generation
passed live smoke. Explicit PNG output selection returned HTTP 400, so only
default output or explicit JPEG is offered; returned PNG/JPEG originals are
preserved. One Nano Banana 2.1 reference-image edit with a local PNG also
returned JPEG through the live API. Edit quality, additional model access and
provider-side PNG return remain unverified. See
`dev-docs/specs/providers/google-provider.md`.

Claude Sonnet 5.5 / Haiku 5.5 (`claude-sonnet-5-5`, `claude-haiku-5-5`) use native adaptive `low|medium|high|xhigh|max` effort with 1M context and 128K output, without Fast. The native adapter preserves signed thinking through durable prefix fingerprints and omits replay when earlier input changes. Sonnet rejects forced tool choice; Haiku retains it. See `dev-docs/specs/providers/anthropic-provider.md`.

GPT-6.1 Terra (`gpt-6.1-terra`) is selectable with `low|medium|high|xhigh|max` and Fast, using the existing 270K normal input cap; Ultrafast is unavailable. API `none` is not exposed by the current reasoning controls. Live API/OAuth access is unverified.

DeepSeek is a builtin API-key provider through `ChatDeepSeek` and stateless HTTP
Responses. Models are `deepseek-flash` (the rolling alias currently serving
V4.1-Flash-1017, default) and `deepseek-v4-pro`; no synthetic pinned version IDs.
Use `DEEPSEEK_API_KEY` or stored API-key auth, never OAuth. Both have conservative
1M context / 384K output limits; Flash alone supports vision. Native effort is
low/high/max; medium/xhigh map to high with diagnostics. Fast is unavailable.
Plaintext reasoning and function results replay through the shared Responses
serializer. Small live tool roundtrips passed on both models on 2026-11-02;
forced named tool choice in thinking mode returned HTTP 400 and is rejected
locally. See `dev-docs/specs/providers/deepseek-provider.md`.

The TUI-local `decision` tool supports OpenAI `gpt-6-luna` and Google
`gemini-decision-1` using explicit API-key auth and bounded shared text/image
inputs. It evaluates predicate, choice and score questions with an internal
permission gate, no retries or provider/auth fallback, and reuses existing image
source safeguards. Live Decisions access is unverified; see
`dev-docs/specs/decisions.md`.

Gemini 4 Carbon / Hydrogen (`gemini-4-carbon`, `gemini-4-hydrogen`) are selectable
through native Google chat. Both reserve 65,536 synchronous thinking/output
tokens inside the shared 1,048,576 context (983,040 input cap). Hydrogen supports
native `xhigh`; canonical `max` maps to `xhigh`, while Carbon/Argon retain the
`high` fallback. Unset effort preserves Google's model defaults. Hydrogen completed native chat/tool and Auto approve rule-suggestion smoke tests on
2026-11-22. Carbon has SDK fixture coverage. See
`dev-docs/specs/providers/google-provider.md`.

Claude Fable 5.2 (`claude-fable-5-2`) supports native five-level adaptive
thinking and Claude Fast, with 1M context / 128K output. The Anthropic adapter
uses prefix-bound thinking replay and rejects forced tool choice and unsupported
sampling/thinking settings. GPT-Image 2.6 Sunburst/Flare are selectable for PNG
generation/editing on the existing OpenAI routes. Neither addition was verified
with a live paid request; see `dev-docs/specs/providers/anthropic-provider.md`
and `dev-docs/specs/image-generation.md`.

TUI mid-run Steer is implemented in `dev-docs/specs/tui-run-steer.md`:
`run.steer` is gated by `supports_run_steer`; Core applies structured polled inputs
only before model steps or natural final completion, never inside tool batches or
forced compaction. Runtime retains polled-but-unconfirmed IDs until canonical
`steer_applied`, and terminal status returns unconsumed IDs for chronological TUI
queue fallback. TUI exposes `/steer`, `/queue mode|steer`, and `Alt+M`; submitted
image/display snapshots survive composer clearing and queue fallback.

Local TUI `/goal` uses the opt-in `supports_goals` protocol and SQLite
session goals, reservations and continuation receipts. `goal.ready` is sent
after successful checkpoint and accounting with the run released. TUI queue
and Steer fallback take priority. Matching pause intent disarms synchronously;
reopen is display-only until explicit resume. Goal usage excludes compaction,
tool-internal calls and child agents. The transient objective follows prior
history and precedes current input and steers. The `update_goal` tool description
sets reporting timing. See `dev-docs/specs/goals.md`.

TUI copied-file paste uses `Alt+V`, immutable client staging and capability-gated
`attachment.upload.*` transfers. Run and Steer inputs contain opaque IDs.
Runtime verifies ownership and projects stored references for the selected
model. Use `attachment_read` for bounded text/hex access. See
`dev-docs/specs/input-attachments.md` for the transport and platform limits.

The local TUI `/auto-approve [status|off]` starts off per workspace. The user can
enable the current workspace without a model selection, follow the actual chat
Agent's built-in provider, or pin a registered reviewer.
All eight built-ins use experimental fixed routes and existing provider auth.
OpenAI Codex OAuth only uses the fixed Codex SSE endpoint. The v3 setup requires fresh selection before sharing shell evidence under older test-only settings.
The workspace choice survives sessions for the same directory identity. The
optional user-wide reviewer preference applies to explicit rule suggestions.
Reviewer availability does not control confined parent shell launches; `additional_write_roots` escalations (outside the workspace or targeting a home dot-directory, excluding Codelia's own config/credentials) route through Auto Review when active and fall back to human confirmation otherwise. When the workspace contains the user's home directory (`~`), ordinary files/folders remain writable in `workspace-write` while top-level dot-entries (`~/.*`, existing and future) and macOS `~/Library` are read-only by default across Seatbelt, Linux gVisor, and built-in/delegated file tools. See
`dev-docs/specs/command-approval-and-auto-review.md`.

macOS Keychain storage (`packages/storage/src/macos-keychain.ts`) uses Apple-signed `/usr/bin/security` directly with base64 chunking (1,800 raw bytes/chunk, max 64 chunks / 115,200 bytes enforced on both write and read) over `/usr/bin/security -i` without shipping a custom Rust helper binary: writes require a confirmed root read (aborting on read/timeout errors), single chunks write `cb1:1:<base64>` with read-back verification, and multi-chunk writes alternate between fixed A/B slots (`<service>#g:a|b:0..N-1`), verify every chunk via read-back, then flip `<service>` to `cb2:a|b:<total>` (logout exhaustively deletes `0..63` in both A/B slots and propagates delete errors). `codelia auth authorize-keychain` runs under `withAuthStoreLock`. See `dev-docs/specs/auth.md` §9.2.

CLI self-update (`packages/cli/src/update/`, `codelia update [--check]`) is configured globally via `update.mode` (`notify` default | `auto` opt-in | `off`) and `update.channel` (plus `CODELIA_AUTO_UPDATE` / `CODELIA_UPDATE_CHANNEL`). Interactive TUI launches run background registry checks (24h success / 1h failure TTL; scope changes clear stale candidates on failure), pass startup notices to Rust TUI via `CODELIA_UPDATE_NOTICE_FILE`, and (on explicit `codelia update` or opt-in `auto`) verify `npm prefix -g` without `--prefix` and apply updates in-place via `npm install -g --prefix <prefix> @codelia/cli@<version>` under `<node_modules>/.codelia-update.lock.sqlite`. See `dev-docs/specs/self-update.md`.

Credential storage v2 and macOS Keychain hardening are implemented in `dev-docs/specs/auth.md` §9:
provider auth v2 supports OAuth + API-key coexistence (`chat_method` + `credentials.{api_key,oauth}`),
env-var API keys stay strictly in memory (never persisted), and MCP auth v2 binds tokens to
canonical `resource_uri`/`issuer`/`token_endpoint`/`client_id` (refusing mismatched endpoints and
dropping unbound legacy v1 entries with `mcp_reauth_required`). Global-only `auth.storage`
(`auto` | `keyring` | `file`, env `CODELIA_AUTH_STORAGE`) selects between macOS Keychain via the
native `Security.framework` helper (`crates/credential-helper`, services `codelia.auth` /
`codelia.mcp-auth`) and `<configDir>/credentials/` (`0700` POSIX / verified owner-only DACL on
Windows, included in default sandbox `protectedPaths` and built-in file-tool denials). An
owner-verified SQLite lock (`.auth-store-lock.sqlite`, 35s wait) + 30s fixed OAuth refresh timeout
+ atomic writes + locked `McpAuthStore.update()` (preserving 401 refresh) + write-ahead
`storage-state.json` prevent split-brain fallback and cross-process races, with all-direction
pre-write conflict detection and `auth.status` non-secret `storage` / `warnings` metadata
(including `inline_mcp_config_secrets`). Follow-up `secret_ref` for inline `config.json` MCP
secrets and Linux/Windows native keyrings remain planned. `bunfig.toml` preloads
`scripts/test-preload.ts` (`CODELIA_AUTH_STORAGE=file`) and disables automatic native helper access in tests. The live macOS test requires explicit
`CODELIA_TEST_LIVE_KEYCHAIN=1`. Production helper operations are noninteractive. After an upgrade,
`codelia auth authorize-keychain` requests access for the current configuration.
