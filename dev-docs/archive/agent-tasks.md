# Agent Tasks Spec (Agent implementation task definition)

This document decomposes the Agent implementation into "executable tasks".
This spec treats `agent-loop.md` / `core-types.md` as canonical.

---

## Task 0: The skeleton of the Agent class

Things to do:
- Provide `Agent` constructor and main fields
- Normalize `tools` to `Map<string, Tool>`
- Initialize `messages` / `tokenCost` / `compactionService`

acceptance:
- `new Agent(...)` can be created
- No dependency type errors (`tsc`)

---

## Task 1: run() (minimal loop)

Things to do:
- Add `systemPrompt` only for the first time
- Add user message and start loop
- Call `ainvoke` (with tools/toolChoice)
- Add `AssistantMessage` to history
- Exit if there are no tool calls

acceptance:
- Minimum round trip (user → assistant) moves
- not exceed `maxIterations`

---

## Task 2: Safeize tool execution

Things to do:
- Convert unknown tool / JSON parse error / tool error to `ToolMessage(is_error=true)`
- Add tool result to history
- Detect done tool (`TaskComplete` or `DoneSignal`)

acceptance:
- All abnormal systems remain in ToolMessage
- You can exit normally with done.

---

## Task 3: runStream (eventization)

Things to do:
- Yield events in sequence as `AsyncIterable<AgentEvent>`
- `ReasoningEvent` → `TextEvent` → tool-related events → `FinalResponseEvent`
- `FinalResponseEvent` is always the last

acceptance:
- Event order can be fixed during testing
- Will not fail even in exceptional cases

---

## Task 4: LLM retry

Things to do:
- Determine `ModelRateLimitError` / `ModelProviderError`
- Exponential backoff (with jitter)
- Allow setting of maximum number of retries and target status code

acceptance:
- Only errors targeted for retry will be re-executed

---

## Task 5: Context Management Integration

Things to do:
- Execute trim judgment of tool output cache at the start of the loop
- Determine and execute compaction at the end of the loop

acceptance:
- tool output total size limit is respected (old output is trimmed and reference ID remains)
- summary is inserted when threshold is exceeded
- compaction is suppressed if `auto=false`

---

## Task 6: usage aggregation

Things to do:
- Accumulate `ChatInvokeUsage` to `TokenCost`
- Can be retrieved with `getUsage()`

acceptance:
- Usage for the number of calls is added up

---

## Task 7: Additional hooks

Things to do:
- Introduced hook for `getIncompleteWorkPrompt`
- If there is an incomplete prompt, add a user message and continue the loop

acceptance:
- no-op if there is no hook
- The string returned by hook is added

---

## Task 8: Test

Things to do:
- Verify agent-loop minimum round trip with MockModel
- Added case for tool call/error/done
- Test the order of events in runStream

acceptance:
- Key paths are ensured by automated testing
