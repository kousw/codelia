# Agent Loop Spec (run/runStream/termination condition)

This document defines the Agent's run loop.
Explicitly separate implemented behavior from future enhancements.

---

## 1. Constructor (configuration)

### 1.1 AgentOptions

Implemented（`packages/core/src/agent/agent.ts`）:

```ts
export type AgentOptions = {
  llm: BaseChatModel;
  tools: Tool[];

  systemPrompt?: string;
  maxIterations?: number;          // default: 200
  toolChoice?: ToolChoice;         // default: undefined

  // context management
  compaction?: CompactionConfig | null;      // default: enabled
  toolOutputCache?: ToolOutputCacheConfig | null; // default: enabled

  // DI
  services?: AgentServices;
  modelRegistry?: ModelRegistry;

  // usage
  enableUsageTracking?: boolean;   // default: true

  // done tool mode
  requireDoneTool?: boolean;       // default: false

  // LLM retry options (declared; retry loop behavior is not implemented yet)
  llmMaxRetries?: number;          // default: 5
  llmRetryBaseDelayMs?: number;    // default: 1000
  llmRetryMaxDelayMs?: number;     // default: 60000
  llmRetryableStatusCodes?: number[]; // default: [429,500,502,503,504]

  // tool permission hook
  canExecuteTool?: ToolPermissionHook;
};
```

Partially implemented:
- `llmMaxRetries` / `llmRetryBaseDelayMs` / `llmRetryMaxDelayMs` / `llmRetryableStatusCodes` are declared in `AgentOptions`, but retry behavior is not implemented in the run loop.

Planned (not implemented):
- `dependencyOverrides`

### 1.2 Internal state (concept)

Implemented:
- `history: HistoryAdapter` (actual history. Maintain order with `commitModelResponse(response.messages)`)
- `tools: Tool[]`
- `usageService: TokenUsageService`
- `compactionService?: CompactionService | null`
- `toolOutputCacheService?: ToolOutputCacheService | null`

---

## 2. Specification of run()

### 2.1 Handling system prompts

Implemented:
- If `systemPrompt` is specified, call `history.enqueueSystem()` at the start of `runStream()`
- Keep "system only once" on `MessageHistoryAdapter` side

### 2.2 Loop pseudocode

```ts
run(message, { signal, session }) {
  enqueueSystemIfAny()
  enqueueUserMessage(message)

  while (iterations < maxIterations) {
    throwIfAborted(signal)
    trimToolOutputs()

    const input = history.prepareInvokeInput({ tools, toolChoice })
    recordLlmRequest(session, input)

    const response = await llm.ainvoke({ ...input, signal })
    recordLlmResponse(session, response)
    usageService.updateUsageSummary(response.usage)

history.commitModelResponse(response) // Add response.messages as is

    const { reasoningTexts, assistantTexts, toolCalls } = collectModelOutput(response.messages)
    emitReasoningEvents(reasoningTexts)

    const hasToolCalls = toolCalls.length > 0

    if (!hasToolCalls) {
      if (!requireDoneTool) {
        // terminal no-tool response
        yield* checkAndCompact()
        emitFinal(assistantTexts.join("\n").trim())
        return
      }
      // requireDoneTool=true means "no tool call" is not terminal
      yield* checkAndCompact()
      continue
    }

    for (toolCall of toolCalls) {
      emitStepStart/toolCall
      const execution = await executeToolCall(toolCall)
      enqueueToolResult(execution.message)
      emitToolResult/stepComplete
      if (execution.done) {
        emitFinal(execution.finalMessage ?? assistantTexts.join("\n").trim())
        return
      }
    }

    yield* checkAndCompact()
  }

  emitFinal(await generateFinalResponse())
}
```

Implemented:
- Add `response.messages` to the history without reconfiguring it on the Agent side.
- At the end without tool call, omit `text` and emit only `final`
- `requireDoneTool=true` keeps looping when there are no tool calls.
- LLM calls within loop currently have no retries (one call)

Planned:
- Implementation of incomplete work hook (prompt for incomplete tasks)

### 2.3 Cancellation / AbortSignal

Implemented:
- `run()` / `runStream()` receive `options.signal`
- Check abort before loop, each iteration, and before tool execution
- Pass `signal` to `llm.ainvoke()` and `ToolContext`
- When canceling, `runStream` can exit without issuing `final`

---

## 3. Specification of runStream()

### 3.1 Event order (1 iteration)

Implemented:
1. `ReasoningEvent` (if there is a reasoning message)
2. `TextEvent` (other than terminal no-tool)
3. For each tool call:
   - `StepStartEvent`
   - `ToolCallEvent`
   - `ToolResultEvent`
   - `StepCompleteEvent`
4. `FinalResponseEvent` on exit

Implemented:
- Do not issue `TextEvent` at the end where there is no tool call

### 3.2 Relationship with run()

Implemented:
- `run()` consumes `runStream()` and returns the first `final`

---

## 4. Tool call execution specifications

### 4.1 unknown tool

Implemented:
- generate `ToolMessage(is_error=true, content="Error: Unknown tool '...'")`
- loop continues

### 4.2 JSON parse failure for arguments

Implemented:
- If parse fails, emit `ToolCallEvent` as `args = { _raw: <raw arguments> }`
- tool execution itself continues (pass raw arguments string to `executeRaw`)

### 4.3 tool execution exception

Implemented:
- tool execution exceptions are converted to `ToolMessage(is_error=true, content="Error: ...")`
- emit `ToolResultEvent(is_error=true)` and `StepCompleteEvent(status="error")`

### 4.4 done Tools (finished)

Implemented:
- When a `TaskComplete` exception is received from the tool layer, it becomes `execution.done=true` and ends with `final`.
- Leave the done side tool message in the history

Planned:
- Support for `DoneSignal` return value method

---

## 5. LLM retry

Implemented:
- Retry within Agent loop is not implemented at this time.

Planned:
- Introduced exponential backoff for 429/5xx etc.
- Judgment based on provider error normalization (`ModelRateLimitError` / `ModelProviderError`)

---

## 6. When maxIterations is reached

Implemented:
- Temporarily assemble the input with "summary user message" added using `generateFinalResponse()` and call LLM
- Summary calls are `tools: null`, `toolChoice: "none"`
- Do not change history directly, process with temporary array of `[...history, summaryMessage]`
- Return fixed fallback statement on failure

---

## 7. Hooks just before termination (incomplete todos, etc.)

Planned:
- hook equivalent to `getIncompleteWorkPrompt`
- Currently only TODO comments, no execution logic implemented
