# Run Visibility Spec (tool progress and status)

This document defines how UI/TUI should visualize tool execution, compaction,
and run status using AgentEvent and UI protocol notifications.

---

## 1. Goals

- Provide continuous feedback while tools are running.
- Make success/failure and duration visible at a glance.
- Prefer existing AgentEvent + run.status/run.context, with optional compaction events.

---

## 2. Inputs

UI receives:

- `agent.event` notifications that wrap `AgentEvent`.
- `run.status` notifications (`running`, `awaiting_ui`, `completed`, `error`, `cancelled`).
- `run.context` notifications (`context_left_percent`).

Relevant AgentEvent types:
- `step_start` (step_id, title, step_number)
- `tool_call` (tool, args, tool_call_id)
- `tool_result` (tool, result, tool_call_id, is_error)
- `step_complete` (step_id, status, duration_ms)
- `compaction_start` (timestamp)
- `compaction_complete` (timestamp, compacted)

---

## 3. UI State Model (recommended)

Maintain per-run UI state:

```ts
export type RunUiState = {
  run_id: string;
  status: "idle" | "running" | "awaiting_ui" | "completed" | "error" | "cancelled";
  context_left_percent?: number | null;
  active_step?: {
    step_id: string;
    tool: string;
    step_number: number;
    started_at_ms: number;
    args_preview?: string;
  } | null;
  last_step?: {
    tool: string;
    status: "completed" | "error";
    duration_ms: number;
  } | null;
};
```

---

## 4. Rendering requirements (minimum)

- Always show a status line with run status and context_left_percent (if present).
- On `step_start`, set `active_step` and show a running indicator (spinner).
- On `tool_call`, update `active_step.tool` and capture a short args preview.
- On `tool_result`, append a log line; highlight errors when `is_error=true`.
- On `step_complete`, clear `active_step` and show `last_step` with duration.
- On terminal `run.status` (`completed`, `error`, `cancelled`), clear `active_step`.
- If a run is cancelled, do not wait for a `final` AgentEvent.
- On `compaction_start`, show a compaction spinner or status note.
- On `compaction_complete`, clear the compaction indicator.

---

## 5. Suggested TUI presentation

- Status line: `RUNNING · tool=<name> · step=<n> · ctx=<percent>%`
- Secondary line for last step: `last: <tool> · <ok|err> · <duration_ms>ms`
- Error states should be colorized and kept in the log.

---

## 6. Edge cases

- ToolResult without StepStart: log it, but do not crash.
- ToolResult may be large; UI should truncate in the status line.
- If multiple tool calls are emitted, each StepStart/Complete pair should update the active step.
