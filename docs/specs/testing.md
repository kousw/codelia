# Testing Spec (tests to implement while learning)

This document is a testing strategy for implementing the TypeScript version “as you understand it”.
The purpose is to "create a working core first and then understand the differences (provider/compaction/tool output cache) step by step."

---

## 1. Test assumptions

- Test runner assumes `bun:test`
- Don't use real LLM API (because it's not stable in CI/local)
- The provider connector is based on “serializer unit tests” and “SDK calls are thin”
- Manual smoke is enabled explicitly with a flag like `INTEGRATION=1`

---

## 2. First MockModel

Prepare `MockModel` that implements `BaseChatModel` and return `ChatInvokeCompletion` (`messages: BaseMessage[]`) for each scenario.

example:

1. First time: messages=[{role:"assistant", content:null, tool_calls:[echo]}]\n2. Second time: messages=[{role:"assistant", content:"done"}]

---

## 3. Agent loop unit test (in order of priority)

### 3.1 run()

- systemPrompt is entered only once for the first time
- When there is a tool call, tool is executed and ToolMessage is entered in the history.
- Quits if there are no tool calls
- ToolMessage(is_error=true) when unknown tool
- If JSON of tool arguments is corrupted, parse error ToolMessage will occur.
- “Additional call for summarization” is made when maxIterations is reached (verified with MockModel)

### 3.2 runStream()

- FinalResponseEvent is always the last
- StepStart/ToolCall/ToolResult/StepComplete for each tool call is in order
- If there is reasoning, ReasoningEvent is issued
- At the end without tool call, only `final` is output instead of `text`

---

## 4. Tools unit testing

- zod validate works (invalid input is rejected before tool execution)
- tool return serialize rule (string/json/parts)
- tool exceptions are converted to is_error ToolMessage
- Check the cases where `output_ref` is given to ToolMessage

---

## 5. Testing Tool output cache

- Old ToolMessages are trimmed when the total size limit is exceeded.
- `output_ref` remains in trimmed ToolMessage
- Can be expanded from reference ID with `tool_output_cache`

---

## 6. Testing Compaction

### 6.1 Summary replacement when threshold exceeded

- Return usage from MockModel and compaction will be triggered in case it exceeds threshold
- messages is replaced with “retain + summary”
- In the case of `auto=false`, compaction is not activated even if the threshold is exceeded.

### 6.2 Formatting the trailing assistant with tool_calls

- When assistant passes history with tool_calls to compaction, tool_calls are removed (API error avoidance logic)

---

## 7. Testing Provider serializer (minimum)

Here, we have a policy of “not calling the SDK” and at least check the following.

- Common Message → Conversion to SDK format does not work
- ToolDefinition → SDK format can be generated
- SDK format tool call → can be returned to common ToolCall

Integration tests for actual SDK calls will be prepared separately as “manual smoke” when needed.
