# Session Store Spec (run persistence)

This document defines how runs are persisted to disk for later inspection and
best-effort replay. It is distinct from the in-memory message history module.

## Implemented archive, compression and dump policy (updated 2026-11-15)

- Original BaseMessages are append-only in `sessions/messages/<session_id>.jsonl`.
  Compaction never rewrites them. `sessions/contexts/<session_id>.json` contains
  the current active messages and the covered archive byte boundary for fast resume.
- Optional awaited `AgentSession.recordMessages` records admitted user/polled,
  assistant/reasoning and original tool messages before trimming/compaction.
  `conversation_search` / `conversation_read` provide bounded same-session access
  to originals. See [conversation-archive.md](conversation-archive.md) for contracts,
  consistency, migration and the historical-evidence boundary.
- Normal `sessions/YYYY/MM/DD/<run_id>.jsonl` files retain lifecycle/conversation
  events and compact `llm.usage`. Full requests/responses/raw tool outputs and
  header prompts/tools are omitted from normal stores.
- `CODELIA_DEBUG=session-dump` enables a separate full stream under
  `sessions/diagnostics/`. It defaults off and is independent of live diagnostics.
- Compact usage is also persisted under `<storage-root>/usage/`, without message
  bodies or opaque provider metadata, independently of event-log maintenance.
  Per-call provider/model identity comes from the matching request sequence, with
  header identity as a fallback. Only provider/name are retained for correlation;
  child runs do not require a model in their header or a full request dump.
- Unpinned normal run logs are compressed to `.jsonl.gz` after 30 days since each
  run's last update or when archived. Conversation/lifecycle events are never expired;
  full diagnostic records and header prompts/tools are removed during archival.
  Compression verifies the retained projection's decompressed SHA-256/length and
  rechecks file identity, lifecycle state and live writers before committing.
- Plain/gzip history replay and ATIF reads are transparent; duplicate representations
  after interruption are replayed once. Existing mixed legacy gzip is rewritten
  atomically to remove diagnostics. A versioned header marker skips repeat conversion.
- Explicit diagnostic dumps may expire under the same unpinned age/archive policy,
  after usage preservation. Messages, contexts, state.db, references, tasks and
  usage are never collected by this maintenance.
- Pin/archive remain independent metadata columns, exposed through `session.update`,
  `/session` and `codelia session`. Ordinary snapshot saves preserve these flags.
  Archive hides the session by default; resume unarchives it.
- ATIF remains opt-in via `CODELIA_ATIF_OUT`, with compact usage and per-sequence
  legacy response fallback. It does not require a full diagnostic dump.

The record schemas below include diagnostic-only records for compatibility.

---

## 1. Goals

- Persist run inputs, outputs, and tool events in an append-only format.
- Capture normal conversation events; full prompt-level auditing is opt-in.
- Avoid rewriting or mutating history after it is written.
- Be resilient to partial writes (JSONL per record).
- Remain forward-compatible as record shapes evolve.

---

## 2. Location

Session store files live under the `sessions/` directory defined in
`dev-docs/specs/storage-layout.md`.

Default layout (recommended):

```
~/.codelia/sessions/YYYY/MM/DD/<run_id>.jsonl
```

- `run_id` is a UUIDv4 string.
- `YYYY/MM/DD` is derived from `started_at` in the header, in UTC.

Session state (for resume) is split into an index DB and per-session message logs:

```
~/.codelia/sessions/state.db
~/.codelia/sessions/messages/<session_id>.jsonl
```

- `session_id` is a UUIDv4 string.
- `state.db` stores session metadata (`updated_at`, `run_id`, `invoke_seq`, summary fields, optional `workspace_root`).
- `state.db` also indexes run logs per session (`session_runs`: `rel_path` PK,
  `session_id`, `run_id`, `started_at`). See §2.1.
- `messages/<session_id>.jsonl` stores original BaseMessages; `contexts/<session_id>.json` stores the active checkpoint.
- Legacy snapshots under `~/.codelia/sessions/state/<session_id>.json` are still
  read for compatibility and migrated to the new layout on access.

### 2.1 Session run index

A run log names its session only in its header, so readers must not discover a
session's runs by reading every header. `state.db` keeps the mapping:

- `session_runs(rel_path TEXT PRIMARY KEY, session_id, run_id, started_at)`,
  index `(session_id, started_at DESC)`. `rel_path` is the canonical
  `YYYY/MM/DD/<run_id>.jsonl` relative to `sessions/` (always the plain name;
  readers resolve plain first, then `.gz`, and skip a log that no longer exists
  or is not a regular file: symlink, FIFO or directory). `started_at` is stored
  normalized to `toISOString()` UTC so text ordering is chronological.
- `SessionStoreWriterImpl` inserts the row when the header record is appended,
  before the header line is written (`ON CONFLICT DO NOTHING`). An index failure
  never fails the run log. `RunEventStoreFactoryImpl` uses the runtime's shared
  `SessionStateStoreImpl`, or creates a default-path one, so every normal run
  log is indexed.
- `SessionStateStoreImpl.listSessionRuns(session_id)` answers from the table
  (newest first) when it is known complete for that session:
  `storage_meta.session_runs_backfilled_at` is set, and the session's latest
  `session_state.run_id` is indexed or recorded in `session_run_checks`.
  Otherwise it performs one store-wide header scan (single-flight per process),
  inserts every session's logs, sets the backfill marker and records the checked
  latest `run_id`, so the next call is index-only. Recording a run also checks
  the session's previous latest `run_id`; if a pre-index runtime wrote it (not
  indexed, not checked), the session is flagged in `session_run_rescans` and the
  next `listSessionRuns` rescans. A backfill clears flags raised before it
  started. Only `ENOENT`/`ENOTDIR`
  directories and permanently unreadable files (vanished, not regular, corrupt
  gzip/JSON) are skipped; any other I/O error (`EMFILE`, `EACCES`, `EIO`, ...)
  aborts the backfill without recording anything, so it is retried. Callers fall
  back to the legacy scan for that request. The latest-run check covers
  logs written by runtimes that predate the index; a latest `run_id` with no log
  is rescanned only once.
- Concurrency: same `state.db` rules as `session_state` (WAL, `busy_timeout`,
  `BEGIN IMMEDIATE` for the backfill batch); rows are idempotent, so concurrent
  runtimes may backfill or record the same log safely.
- `session.history` still reads each selected log's header (as the legacy
  selector did): unreadable, corrupt or other-session logs are skipped and do not
  consume `max_runs`.
- Consumers: `session.history` and session-scoped run-log cleanup (archive). The
  startup retention pass still walks every file because it needs every mtime.


---

## 3. JSONL record format

Each line is a JSON object with a `type` field. All records except `header`
include `ts` (ISO 8601/RFC3339 UTC string, e.g. `2026-02-03T12:34:56.789Z`).
Unknown fields must be ignored for forward compatibility.

```ts
export type SessionRecord =
  | SessionHeader
  | RunStartRecord
  | RunContextRecord
  | AgentEventRecord
  | ToolOutputRecord
  | LlmUsageRecord
  | LlmRequestRecord
  | LlmResponseRecord
  | RunStatusRecord
  | RunErrorRecord
  | RunEndRecord;

export type SessionHeader = {
  type: "header";
  schema_version: 1;
  run_id: string;
  session_id?: string;
  started_at: string; // ISO 8601 UTC string
  client?: { name: string; version: string };
  server?: { name: string; version: string };
  model?: { provider?: string; name?: string; reasoning?: string };
  prompts?: { system?: string };
  tools?: { definitions?: unknown[]; source?: string };
  runtime?: { cwd?: string; os?: string; arch?: string; version?: string };
  meta?: Record<string, unknown>;
};

export type RunStartRecord = {
  type: "run.start";
  run_id: string;
  session_id?: string;
  ts: string;
  input: { type: "text"; text: string };
  ui_context?: unknown; // UiContextSnapshot (see dev-docs/specs/ui-protocol.md)
  meta?: Record<string, unknown>;
};

export type RunContextRecord = {
  type: "run.context";
  run_id: string;
  ts: string;
  context_left_percent: number;
  meta?: Record<string, unknown>;
};

export type AgentEventRecord = {
  type: "agent.event";
  run_id: string;
  ts: string;
  seq: number;
  event: AgentEvent;
  meta?: Record<string, unknown>;
};

export type ToolOutputRecord = {
  type: "tool.output";
  run_id: string;
  ts: string;
  tool: string;
  tool_call_id: string;
  result_raw: string;
  is_error?: boolean;
  output_ref?: { id: string; byte_size?: number; line_count?: number };
  meta?: Record<string, unknown>;
};

export type LlmRequestRecord = {
  type: "llm.request";
  run_id: string;
  ts: string;
  seq: number; // invocation number
  model?: { provider?: string; name?: string; reasoning?: string };
  input: {
    messages: BaseMessage[]; // serialized as JSON in JSONL
    tools?: ToolDefinition[] | null; // serialized as JSON in JSONL
    tool_choice?: ToolChoice | null; // serialized as JSON in JSONL
    model?: string;
  };
  meta?: Record<string, unknown>;
};

export type LlmUsageRecord = {
  type: "llm.usage";
  run_id: string;
  session_id?: string;
  ts: string;
  seq: number;
  model?: { provider?: string; name?: string };
  output: {
    usage?: LlmResponseRecord["output"]["usage"];
    timing?: LlmCallTiming;
    stop_reason?: string | null;
  };
};

export type LlmResponseRecord = {
  type: "llm.response";
  run_id: string;
  ts: string;
  seq: number; // matches llm.request.seq
  output: {
    messages: BaseMessage[]; // serialized as JSON in JSONL
    usage?: {
      model: string;
      input_tokens: number;
      input_cached_tokens?: number | null;
      input_cache_creation_tokens?: number | null;
      input_image_tokens?: number | null;
      output_tokens: number;
      total_tokens: number;
    } | null;
    stop_reason?: string | null;
    provider_meta?: unknown;
  };
  meta?: Record<string, unknown>;
};

export type RunStatusRecord = {
  type: "run.status";
  run_id: string;
  ts: string;
  status: "running" | "awaiting_ui" | "completed" | "error" | "cancelled";
  message?: string;
  meta?: Record<string, unknown>;
};

export type RunErrorRecord = {
  type: "run.error";
  run_id: string;
  ts: string;
  error: { name: string; message: string; stack?: string };
  meta?: Record<string, unknown>;
};

export type RunEndRecord = {
  type: "run.end";
  run_id: string;
  ts: string;
  outcome: "completed" | "cancelled" | "error";
  final?: string;
  meta?: Record<string, unknown>;
};
```

### 3.1 Session state (resume)

Session state snapshots are stored separately from run JSONL and represent the
current in-memory active history for resume; originals have independent append-only persistence.

- Logical shape is `SessionState` below.
- Physical storage is `state.db` + `contexts/<session_id>.json`; originals remain
  independently append-only in `messages/<session_id>.jsonl`.
- Snapshots are durable-history oriented: runtime strips startup-generated system
  context (current system prompt / execution-environment / initial AGENTS / initial
  skills catalog / injected resume reminder) before persisting `messages`.

```ts
export type SessionState = {
  schema_version: 1;
  session_id: string;
  updated_at: string; // ISO 8601 UTC string
  run_id?: string; // last run_id
  invoke_seq?: number; // last LLM invoke seq
  messages: BaseMessage[]; // serialized as JSON in JSONL
  meta?: Record<string, unknown>;
};
```

---

## 4. Ordering and durability

- Records are appended in the order they are observed.
- `agent.event.seq` must be preserved to keep UI playback order.
- `llm.request.seq` / `llm.response.seq` must match for each invocation.
- A crash may leave a file without `run.end`; readers should handle that.

---

## 5. Replay and compaction notes

- `agent.event` is optimized for UI playback, not full replay.
- For opt-in prompt-level replay, use diagnostic `llm.request` snapshots (they already include
  any compaction/trimming performed at the time of invocation).
- Diagnostic `tool.output.result_raw` stores the full text projection for reproducibility.
- Compaction events appear as `agent.event` with
  `type: "compaction_start"/"compaction_complete"`.

---

## 6. Resume and environment notes

- Authoritative resume semantics are defined in `dev-docs/specs/session-resume-semantics.md`.
- Session files are append-only; do not rewrite the header.
- If resuming in a different filesystem location, current runtime state (for example cwd, workspace root, sandbox root, tool availability, AGENTS scope, and skills catalog) should be recomputed before the first resumed user turn.
- Runtime snapshots persist resume context without startup-generated system context; opt-in diagnostic JSONL preserves the original startup prompt.
- Material changes between saved and current context should be surfaced via a compact resume-diff reminder before the first resumed user turn.
- Current-workspace resume pickers may use stored `workspace_root` summary metadata to avoid mixing sibling worktrees/lane sessions by default.

---

## 7. Diagnostic JSONL example (opt-in)

```jsonl
{"type":"header","schema_version":1,"run_id":"8f1d7b7a-7e8f-4e0f-9a7c-1c5d0e6b2b7a","started_at":"2026-02-03T12:00:00.123Z","client":{"name":"tui","version":"0.1.0"},"server":{"name":"runtime","version":"0.1.0"},"model":{"provider":"openai","name":"gpt-4.1-mini","reasoning":"medium"},"prompts":{"system":"You are a coding assistant."}}
{"type":"run.start","run_id":"8f1d7b7a-7e8f-4e0f-9a7c-1c5d0e6b2b7a","ts":"2026-02-03T12:00:00.456Z","input":{"type":"text","text":"list files"},"ui_context":{"cwd":"/path/to/project"}}
{"type":"llm.request","run_id":"8f1d7b7a-7e8f-4e0f-9a7c-1c5d0e6b2b7a","ts":"2026-02-03T12:00:01.000Z","seq":1,"model":{"provider":"openai","name":"gpt-4.1-mini"},"input":{"messages":[{"role":"system","content":"You are a coding assistant.","message_ts":"2026-02-03T12:00:00.123Z"},{"role":"user","content":"list files","message_ts":"2026-02-03T12:00:00.456Z"}],"tools":[{"type":"function","function":{"name":"exec_command","description":"Runs a command in a PTY.","parameters":{"type":"object","properties":{"cmd":{"type":"string"}},"required":["cmd"]}}}],"tool_choice":null,"model":"gpt-4.1-mini"}}
{"type":"llm.response","run_id":"8f1d7b7a-7e8f-4e0f-9a7c-1c5d0e6b2b7a","ts":"2026-02-03T12:00:02.100Z","seq":1,"output":{"messages":[{"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"exec_command","arguments":"{\"cmd\":\"ls\"}"}}]}],"usage":{"model":"gpt-4.1-mini","input_tokens":120,"output_tokens":15,"total_tokens":135},"stop_reason":"tool_use"}}
{"type":"agent.event","run_id":"8f1d7b7a-7e8f-4e0f-9a7c-1c5d0e6b2b7a","ts":"2026-02-03T12:00:02.150Z","seq":0,"event":{"type":"tool_call","tool":"exec_command","args":{"cmd":"ls"},"tool_call_id":"call_1"}}
{"type":"tool.output","run_id":"8f1d7b7a-7e8f-4e0f-9a7c-1c5d0e6b2b7a","ts":"2026-02-03T12:00:02.600Z","tool":"exec_command","tool_call_id":"call_1","result_raw":"AGENTS.md\nRULES.md\npackages\n","output_ref":{"id":"call_1","byte_size":33,"line_count":3}}
{"type":"agent.event","run_id":"8f1d7b7a-7e8f-4e0f-9a7c-1c5d0e6b2b7a","ts":"2026-02-03T12:00:02.700Z","seq":1,"event":{"type":"final","content":"Here are the files: AGENTS.md, RULES.md, packages."}}
{"type":"run.status","run_id":"8f1d7b7a-7e8f-4e0f-9a7c-1c5d0e6b2b7a","ts":"2026-02-03T12:00:02.750Z","status":"completed"}
{"type":"run.end","run_id":"8f1d7b7a-7e8f-4e0f-9a7c-1c5d0e6b2b7a","ts":"2026-02-03T12:00:02.800Z","outcome":"completed","final":"Here are the files: AGENTS.md, RULES.md, packages."}
```

Session state example:

```json
{
  "schema_version": 1,
  "session_id": "f6d2c6d5-4a12-4cc4-bbc9-9a0c0d2b5af1",
  "updated_at": "2026-02-03T12:00:02.900Z",
  "run_id": "8f1d7b7a-7e8f-4e0f-9a7c-1c5d0e6b2b7a",
  "invoke_seq": 1,
  "messages": [
    { "role": "system", "content": "You are a coding assistant." },
    { "role": "user", "content": "list files" },
    { "role": "assistant", "content": "Here are the files: AGENTS.md, RULES.md, packages." }
  ]
}
```

---

## 8. Schema evolution policy

- Prefer additive changes (new optional fields or new record types).
- Breaking changes must bump `schema_version` in the header.
- Readers should treat unknown `schema_version` as unsupported or fall back to a
  best-effort mode (ignoring fields they do not understand).
- Avoid making existing optional fields required.

---

## 9. Compatibility notes

- Additional record types are allowed (ignore unknown).
- New fields must be optional to keep old readers working.
- Readers must tolerate unknown string enum values (e.g. `run.status`).
- The `meta` object is reserved for forward-compatible extensions.
 - New custom record types should use a namespaced prefix
   (e.g. `x.<org>.foo`) to avoid collisions.
 - `schema_version` increments only on breaking changes; compatible changes
   should not bump it.
