# Session Store Spec (run persistence)

This document defines how runs are persisted to disk for later inspection and
best-effort replay. It is distinct from the in-memory message history module.

---

## 1. Goals

- Persist run inputs, outputs, and tool events in an append-only format.
- Capture enough data to replay or audit a run (best-effort).
- Avoid rewriting or mutating history after it is written.
- Be resilient to partial writes (JSONL per record).
- Remain forward-compatible as record shapes evolve.

---

## 2. Location

Session store files live under the `sessions/` directory defined in
`docs/specs/storage-layout.md`.

Default layout (recommended):

```
~/.codelia/sessions/YYYY/MM/DD/<run_id>.jsonl
```

- `run_id` is a UUIDv4 string.
- `YYYY/MM/DD` is derived from `started_at` in the header, in UTC.

Session state snapshots (for resume) live under:

```
~/.codelia/sessions/state/<session_id>.json
```

- `session_id` is a UUIDv4 string.


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
  ui_context?: unknown; // UiContextSnapshot (see docs/specs/ui-protocol.md)
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

Session state snapshots are stored separately from JSONL and represent the
current in-memory history for resume.

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
- For prompt-level replay, use `llm.request` snapshots (they already include
  any compaction/trimming performed at the time of invocation).
- `tool.output.result_raw` stores the full tool output for reproducibility.
- Compaction events appear as `agent.event` with
  `type: "compaction_start"/"compaction_complete"`.

---

## 6. Resume and environment notes

- Session files are append-only; do not rewrite the header.
- If resuming in a different filesystem location, update runtime environment
  (e.g. cwd or project root) before the first `llm.request`.
- If the LLM must be aware of the new environment, inject a system
  message at resume time.

---

## 7. JSONL example

```jsonl
{"type":"header","schema_version":1,"run_id":"8f1d7b7a-7e8f-4e0f-9a7c-1c5d0e6b2b7a","started_at":"2026-02-03T12:00:00.123Z","client":{"name":"tui","version":"0.1.0"},"server":{"name":"runtime","version":"0.1.0"},"model":{"provider":"openai","name":"gpt-4.1-mini","reasoning":"medium"},"prompts":{"system":"You are a coding assistant."}}
{"type":"run.start","run_id":"8f1d7b7a-7e8f-4e0f-9a7c-1c5d0e6b2b7a","ts":"2026-02-03T12:00:00.456Z","input":{"type":"text","text":"list files"},"ui_context":{"cwd":"/home/kousw/cospace/codelia"}}
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
