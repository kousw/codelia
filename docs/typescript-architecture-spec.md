# TypeScript version Agent SDK Architecture Spec (reproduction of Python implementation)

This document is an Architecture Spec for reproducing and implementing the core functionality of `bu-agent-sdk` (Python) in TypeScript.

- Purpose: Downgrade to a TS implementation with **equivalent behavior/equivalent extension points**
- Target providers: **OpenAI / Anthropic / Gemini** (narrow down to 3)
- Policy: Agree on the architecture first, then create a detailed spec for each function in `docs/specs/`

---

## 0. Scoped/Unscoped

### Scope (reproducing the main features of the Python version)

- Agent loop (`run` / `runStream`, history management, max iterations, tool execution)
- Tool definition (schema generation, DI equivalent, execution, serialization of results)
- Discard Ephemeral tool output ("Keep only the last N" for each tool)
- Context compaction (replace history with summary at threshold)
- Supports 3 providers (OpenAI/Anthropic/Gemini) and serializer layer
- Token usage aggregation (optional cost calculation)
- Observability (optional no-op)
- Retry/error handling (LLM call/tool execution)

### Distribution image (separate core and cli)

It is assumed that a "practical toolset + UI/input/output" like `examples/claude_code.py` in the Python version will be extracted as `cli` (reference implementation/distribution) on the TS side.

- `core`: Agent loop + provider + tool infrastructure (minimal)
- `cli`: Display and interact with default toolsets (e.g. planning/todos, fs, grep, edit, bash, etc.)

Although planning (todos) is a "practical standard tool for stabilizing agents," we will not make it a required feature of the core, but rather provide it as standard with the cli (the core will work "with or without the planning tool").

### Non-scoped (not aimed at this stage)

- deepagents-like "planning board", "subagent", "long-term memory/DB integration", etc.
- Browser operations and OS sandboxing (can be added as a tool, but not a core requirement of the SDK)

---

## 1. Design principles

- **Agent = for-loop** (as transparent as possible, easy to debug)
- **Make shared types canonical** (provider differences are absorbed by adapter/serializer)
- **TypeScript is centered around zod** (tool input is zod for type inference + validation)
- **Optional features fall as no-op** (observability / cost, etc.)

supplement:
- Place the model list as a snapshot in `packages/core/src/models/`
- alias assumes a simple name such as `default` (resolve is via registry)

---

## 2. Public API (goal)

### 2.1 Agent

- `new Agent({ llm, tools, ... })`
- `run(message): Promise<string>`
- `runStream(message): AsyncIterable<AgentEvent>`
- `clearHistory()`
- `loadHistory(messages)`
- `getUsage(): Promise<UsageSummary>`

Make sure the API names on the TS side are the same (even if they don't exactly match the Python version, it's OK as long as the concepts correspond).

### 2.2 done Tools

- Terminate when LLM no longer returns tool calls (standard behavior)
- `done` can be used as an explicit termination signal, but is not required.

### 2.3 planning (todos) is provided as a standard cli tool

The model allows you to write plans ``on your own'' in text, but plans tend to become volatile for long tasks, so prepare a structured planning tool (e.g. `write_todos`).

- `core`: Planning is not required (removed from core requirement for reproduction implementation)
- `cli`: Planning is included as standard and provides UI/display (ToDo list) and "return if there are unfinished ToDos" behavior.

This separation allows us to keep library usage to a minimum while providing a stable “Plan → Execute → Update” loop when using the CLI.

---

## 3. Agent loop specifications (key points of behavior)

### 3.1 Message history

- Only the first `run/runStream`, if there is `systemPrompt`, add it to the beginning
- From now on, add user/assistant/tool message to the history.

### 3.2 Flow of 1 iteration (concept)

1. Discard Ephemeral output (previous iteration)
2. LLM call (messages + tools + toolChoice)
3. Add AssistantMessage to history
4. If there are tool calls, execute them in order and add ToolMessage to the history.
5. Judgment and execution of compaction
6. Termination judgment (in CLI mode, termination with "no tool calls")

### 3.3 Reaching maximum iterations

- When `maxIterations` is reached, return a summary of "what was done" from the history using LLM (follows the behavior of the Python version)

---

## 4. Tool specifications (reorganized for TS)

### 4.1 Tool definition (basic form)

- `name`, `description`
- `input`: Zod schema (generate JSON Schema from here)
- `execute(input, ctx)`
- Assumes trim/reference ID by tool output cache

### 4.2 DI (equivalent to Depends)

The purpose of Python's equivalent to `Depends` is to "resolve dependencies and be able to override them when the tool is run."

Implementation details are optional in TS, but ultimately the following must be satisfied:

- Dependencies can be resolved either synchronously or asynchronously
- **dependency overrides** (replacement) possible from Agent/test side

### 4.3 Result serialization / multimodal

- tool result allows `string` or `JSON` or `content parts（text/image/document）`
- Unify the format so that the serializer layer can be converted to the provider format

---

## 5. Context management（Tool output cache / Compaction）

### 5.1 Tool output cache

- Trim from old output and leave reference ID when total size limit exceeds
- The trimmed output is replaced by a placeholder and can be extracted from the reference ID.

### 5.2 Compaction

- `enabled=true` is the default (same as Python version)
- `auto=true` is the default (automatic compaction can be suppressed)
- `thresholdRatio=0.8` default
- The threshold is calculated from the context length of the model (if it cannot be obtained, an error occurs; it is assumed that the metadata is obtained externally and the registry is enriched)
- compaction summarizes the entire history and replaces the history with "1 summary"
- When summarizing, adjust the "tool calls of the trailing assistant" to avoid provider API errors (equivalent to the Python version of prepare)
- Additional instructions (summaryDirectives) can be added to summary

---

## 6. Providers（OpenAI / Anthropic / Gemini）

### 6.1 Common Interface

- `ainvoke({ messages, model?, tools?, toolChoice?, signal? }): Promise<ChatInvokeCompletion>`
- `ChatInvokeCompletion` has `messages`, `usage`, `stop_reason`, `provider_meta`
- Implemented: text/tool_calls/reasoning is handled in the order of `messages: BaseMessage[]`

### 6.2 serializer layer

- Convert common Message/Tool definitions to the format required by each SDK
- "trimmed ToolMessage" sends placeholder
- OpenAI plans to use Responses API (`responses.create`)
- When restoring OpenAI assistant history, use `output_text` / `refusal` to assemble input item

---

## 7. Token usage / cost

- Aggregate usage of all LLM calls and return in `getUsage()`
- Cost calculation is performed only when `includeCost` is enabled (no external acquisition is performed when disabled)

---

## 8. Observability (optional)

- no-op if there are no dependencies
- If there is, `run/runStream` and tool execution can be wrapped in span

---

## 9. Details spec (reference)

Detailed specifications for each function are summarized in `docs/specs/`.

- `docs/specs/core-types.md` (common type/compatibility definition)
- `docs/specs/agent-loop.md` (run/runStream, termination condition, max iterations)
- `docs/specs/tools.md`（zod/JSON Schema、DI、serialization、tool output cache）
- `docs/specs/context-management.md` (tool output cache/compaction details)
- `docs/specs/providers.md` (OpenAI/Anthropic/Gemini adapter/serializer policy)
- `docs/specs/storage.md` (usage/cost, save tool output cache)
- `docs/specs/testing.md` (Test order that can be implemented while learning)
- `docs/specs/implementation-plan.md` (implementation order and acceptance)
