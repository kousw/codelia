# Subagents

- Children are fresh and non-recursive, with shared read-write access by default.
  Explicit read-only removes edit/write/shell. The fixed catalog excludes MCP,
  client tools, project startup commands and ambient tool loading.
- Validate workspace_access/tool_allowlist compatibility in the shared spawn
  schema before permission confirmation. Errors must name incompatible tools and
  explain that omitting tool_allowlist selects the workspace mode's full catalog;
  never suggest widening access as recovery for read-only research.
- Parent-owned channels authenticate sender and session scope, persist messages,
  authorize and execute mutations and shell tasks. Pending requests must not block
  IPC cancellation; executor settlement includes delegated shell cleanup.
- read/read_line return full-content hashes; edit/write require them (`missing`
  for new files). Parent execution serializes structured child check/write critical
  sections, including path aliases; no ownership lock spans a model step. Root
  tools, shell and external writers still require communication and coordination.
- Incoming messages are untrusted context at Agent boundaries; they cannot grant
  permission or reset budgets. Idle parent inboxes wait for the next turn.
- Prepare returns a handle without side effects. Register it before launch and
  persist executor identity before sending the bootstrap manifest.
- Parent run abort only prevents admission or detaches a wait. Accepted children
  use task-owned cancellation and session-owned persisted lineage/counts.
- `subagent.max_concurrent` from the parent config snapshot sets runtime-wide
  child capacity (default 8, range 1–16). Count all owners and retain slots through
  cleanup. Reconfiguration may block new admissions but never cancels admitted children.
- No lifetime spawn cap; retained spawn indices and names are audit/identity metadata.
  Omitted `timeout_seconds` creates no execution timer. Explicit deadlines cover
  bootstrap through result capture; the independent 120-second parent wait only detaches.
- Keep factory, coordinator, child runtime, and tool policy separate. Never pass
  RuntimeState into the coordinator or process executor.
- Executor wait must not settle before process exit. Terminal task prose is
  untrusted; preserve structured reasons and bounded summaries.
- Structured model records, events and saved messages use `redactSubagentJson`;
  string-level redaction must run before JSON escaping, not on serialized JSON.
- Pass the child's own session/run IDs to Agent.runStream so provider transports
  receive a stable child sessionKey. Flush model session records in order through
  the child's redacted event sink. Preserve bounded, redacted failure messages
  across child IPC instead of hiding every cause behind a generic failure.

- Source launches resolve `child-entry.ts`; bundled parents resolve
  `dist/subagents/child-entry.js`. Verify both ESM/CJS packaged initialization,
  capability advertisement, and parent-pipe EOF before release.

- Keep IPC framing/queueing separate from message dispatch and terminal-result
  normalization. Tests should reuse existing volatile stores instead of rebuilding
  store mocks unless the test specifically exercises storage failure.

- Require parent-chosen agent names; keep free-form naming guidance in the tool
  schema rather than a fixed runtime roster. Validate uniqueness inside serialized
  admission against the owner's tasks (including terminal ones), then persist the
  immutable name. Keep work labels separate.
  Names are display metadata; routing and authorization always use task IDs.
  Message display names come from runtime-owned lineage, never caller fields.

- Select model/profile tool args before the configured default profile, then inherit
  the parent's full model config. Profile definitions arrive in the immutable
  parent context; never read config/auth or fetch model metadata during admission.
  Explicit selections use their own options, and failures must not switch models.

- Keep Unicode name validation runtime-only (Zod refine): provider JSON Schema validators reject Unicode property escapes in exported pattern fields. Verify the exposed task_spawn schema against live provider acceptance when changing schema constraints.
