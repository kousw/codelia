# Implementation Plan Spec (order of implementation while learning)

This document is a step-by-step guide for implementation while "understanding the specifications."
Each step clarifies the “completion conditions (acceptance)” and “learning points”.

---

## 0. Assumptions

- First, implement “core library” (Agent loop / tools / context)
- CLI (practical toolset such as planning tools and file operations) will be created after core is completed
- Do not use the actual LLM API at first, proceed with MockModel (testability)

---

## 1. Step 1: Harden core types

Target: `docs/specs/core-types.md`

Things to do:
- Define BaseMessage / ToolCall / ToolDefinition / ChatInvokeCompletion / AgentEvent in TS

acceptance:
- `tsc` passes
- `AgentEvent` can be determined by testing (`switch(event.type)` can be checked exhaustively)

Points to learn:
- "Making shared types canonical" makes provider differences thinner

---

## 2. Step 2: Create defineTool (zod→validate→serialize)

Target: `docs/specs/tools.md`

Things to do:
- Implement `defineTool()` (input zod / execute / result serialize)
- JSON Schema generation can be done using a stub (replaced later)

acceptance:
- zod validate works
- You can create a ToolMessage equivalent of is_error when an exception occurs.

Points to learn:
- Boundaries for “running tools safely” (JSON parse/validate/serialize)

---

## 3. Step 3: Agent minimal loop (MockModel + echo/done)

Target: `docs/specs/agent-loop.md`
Related: `docs/specs/agent-tasks.md`

Things to do:
- Implements `Agent.run()`
- Create `MockModel` and reproduce tool calls round trip in test

acceptance:
- 1) tool call → 2) tool result → 3) final text round trip works
- unknown tool / parse error / tool error enters history as ToolMessage

Points to learn:
- The body of the agent is “just a while-loop”

---

## 4. Step 4: runStream (eventization)

Things to do:
- Implement `Agent.runStream()` with `AsyncIterable<AgentEvent>`
- Convert the concept of “step” into an event (StepStart/Complete)

acceptance:
- Testing ensures the expected order of events
- FinalResponseEvent is always the last

Points to learn:
- How to convert “loop internal state” into a form that can be observed by UI/CLI

---

## 5. Step 5: tool output cache (trim + reference ID)

Target: `docs/specs/context-management.md`

Things to do:
- save full output in tool output cache and generate reference ID
- Trim old ToolMessages if total size limit exceeds
- Serializer makes the trimmed output a placeholder (check with “common serializer” even before provider implementation)

acceptance:
- Old outputs are trimmed according to total size limit
- Replaced by placeholder and can be expanded from reference ID

Points to learn:
- The importance of separating “history shown to the model” and “internal retention”

---

## 6. Step 6: compaction

Things to do:
- Implements `CompactionService`
- When the threshold is exceeded, the history is replaced with one summary.
- Add removal logic for assistant tool_calls at the end

acceptance:
- Compact works under the threshold condition and the history becomes one item.
- `<summary>` Extraction works

Points to learn:
- Long-term dialogue can be continued by “folding states into summaries”

---

## 7. Step 7: Usage aggregation (cost later)

Target: `docs/specs/usage-tracking.md`

Things to do:
- Implement equivalent to `TokenCost`, accumulate usage and return in `getUsage()`

acceptance:
- MockModel usage can be accumulated

Points to learn:
- “What and how much was used” is important in operation

---

## 8. Step 8: provider connectors（OpenAI→Anthropic→Gemini）

Target: `docs/specs/providers.md`

Things to do:
- Implemented OpenAI connector (conversion of messages/tools/toolChoice)
- Then Anthropic, then Gemini

acceptance:
- Each can return `ChatInvokeCompletion` (minimum)
- Serializer unit test passes

Points to learn:
- The reality of “the difference is absorbed by the provider”

---

## 9. Step 9: CLI (Standard Toolset)

Things to do:
- Create CLI using core
- Includes “practical tools” such as planning (todos) / fs / grep / edit / bash / done

acceptance:
- “Little coding assistant” works as a demo

Points to learn:
- It is easier to understand if the SDK and application (cli) are separated.
