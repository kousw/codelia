# Runtime Subagents (`packages/runtime/src/subagents/`)

Spec: `dev-docs/specs/task-orchestration.md` & `dev-docs/specs/subagent-collaboration.md`.

## Isolation, Bootstrap & Lifecycle

- Fresh, depth-one, non-recursive child tasks (shared read-write default; `readonly` strips edit/write/shell). Exclude MCP, client tools, project startup commands, and ambient tool loading. Validate `workspace_access`/`tool_allowlist` compatibility in the shared spawn schema before confirmation (never suggest widening read-only research to recover).
- `child-entry.ts` (source) / `dist/subagents/child-entry.js` (bundled) reads bootstrap manifest over inherited FD 3 pipe independently of stdin — never pass credentials via argv/env. Test both ESM/CJS packaged bootstrap and parent-pipe EOF; transport fixtures must wait for manifest on FD 3 before RPC.
- Fail closed on unsupported context/workspace modes, tools, or host factories (`tui-local` only unless `subagentExecutorFactory` is injected). Keep `RuntimeState` out of coordinators and process executors.
- `TaskManager.spawnPrepared`: register cancellation handle and persist admission + PID before launching bootstrap; settle `wait` only after process exit. Parent `run.cancel` only rejects admission or detaches waits; accepted children keep task-owned cancellation and session-owned persisted lineage/counts. `subagent.max_concurrent` (1–16, default 8, project overrides global, plus host limits) is shared across all owners and retained until executor cleanup finishes. No lifetime quota; `timeout_seconds` is opt-in (distinct from the 120s bounded parent wait).

## Parent Channels, Concurrency & Naming

- Parent-owned channels authenticate sender/session, persist mailboxes (bounded UTF-8 IPC frames and stored messages; incoming messages inject at safe Agent boundaries as untrusted context and cannot grant permissions or reset budgets; parent-bound messages stay readable after child exit; pending requests must never block IPC cancellation, and reconfiguring settings does not cancel already-admitted children), and authorize workspace reads/mutations/shell (`read`/`read_line` enforce private paths/ceilings/grants before returning names or content; discard if owning session/workspace/authority revokes mid-request).
- `edit`/`write` require `content_sha256` (`missing` for new files); on mismatch, re-read and reconcile (never auto-overwrite or roll back), and serialize parent check/write critical sections (including path aliases) without holding that queue across UI approval. Each child shell request resolves the owning parent's *current* sandbox mode clamped under the child's fixed delegated ceiling (`readonly` or `workspace-write`: parent switching to `readonly` narrows surviving children, while `full-access` stays capped at `workspace-write`) and keeps process groups owned until cleanup finishes.
- Parent chooses unique agent names per owner session (`task_id` remains routing/auth identity; display names in messages come from runtime lineage). Keep Unicode name validation runtime-only via Zod `refine` (provider JSON Schema validators reject Unicode property escapes in `pattern`).

## Model Selection, Redaction & Progress

- Deterministic selection order: explicit `profile`/`model` tool arg -> `subagent.default_profile` -> parent model config; preserve named endpoint definitions (`model.providers`) as a validated bootstrap snapshot — never model-callable spawn arguments — along with endpoint `retryPolicy` without network probes, OpenAI auth fallback, or model substitution.
- Redact structured records/events/errors via `redactSubagentJson` *before* JSON serialization (redacting escaped JSON strings can corrupt quotes); bind child's own `sessionKey`; keep parent-visible error causes <= 2048 UTF-8 bytes without stacks/headers; prose results stay untrusted while typed terminal reasons are preserved.
- `conversation_search`/`conversation_read` in children read only the child's own redacted archive. `progress.ts` reports step count, phase, and tool names only (never tool args/results/model text).
