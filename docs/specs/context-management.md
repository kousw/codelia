# Context Management Spec（tool output cache / compaction）

This document defines two mechanisms for the problem of conversational context becoming bloated and corrupted.

- tool output cache: retains tool output as much as possible, trims old output when the limit is exceeded and leaves a reference ID
- compaction: replace history with summary at token threshold

---

## 1. Tool Output Cache

### 1.1 Purpose

- Prevent context from exploding with output such as DOM/screenshots/massive logs
- However, the tool output is retained as much as possible because it is “recently necessary”
- Ability to instantly retrieve content from a reference ID when needed

### 1.2 Terminology

- tool output cache: A cache that stores the full contents of tool output.
- in-context view: Output sent to model (trimmed if necessary)
- output ref: cache reference ID (`ToolOutputRef`)

### 1.3 Configuration (ToolOutputCacheConfig)

```ts
export type ToolOutputCacheConfig = {
  enabled?: boolean;          // default true
contextBudgetTokens?: number | null; // null = derived from model context
  maxMessageBytes?: number;   // default 50 * 1024
  maxLineLength?: number;     // default 2000
};
```

If `contextBudgetTokens` is `null`, calculate as follows:

```
budget = clamp(context_window * 0.25, 20_000, 60_000)
```

The token can be an approximation of byte/4 if there is no real tokenizer.

### 1.4 ToolOutputRef

```ts
export type ToolOutputRef = {
  id: string;
  byte_size?: number;
  line_count?: number;
};
```

ToolMessage optionally has `output_ref` (reference ID).

### 1.5 Caching

Once the tool output occurs:

1. Save full contents to tool output cache and get `ToolOutputRef`
2. Generate in-context view and set it to ToolMessage
3. Keep `output_ref` in ToolMessage

### 1.6 Generating in-context views

- Cut at line 1 `maxLineLength`
- Abort if total exceeds `maxMessageBytes`
- If it is discontinued, add a note to the end saying "Continuation can be expanded with reference ID"

### 1.7 Trim when total size exceeds

If the total token estimate in the tool output exceeds `contextBudgetTokens`:

1. Prioritize and retain the most recent tool output (candidate in order of oldest)
2. Replace `content` in old ToolMessage with placeholder
3. Leave `output_ref` and expand it with `tool_output_cache` if necessary

Example placeholder: `"[tool output trimmed; ref=...]"`.

### 1.8 Deployment (tool_output_cache)

Provide standard tools for retrieving content from reference IDs:

```
tool_output_cache({ ref_id, offset?, limit? })
```

`offset/limit` is handled on a row basis. The return value is text with line numbers equivalent to `read`.
Prepare `tool_output_cache_grep` for search purposes (see tools spec).

### 1.9 GC (optional)

`ToolOutputRef` that is no longer referenced by compaction etc. can be targeted for deletion.

### 1.10 TODO (future improvement)

- `tool_output_cache` read/grep supports streaming assuming huge output
- For the tool output cache, consider a method that fully retains content parts (image/document, etc.)

---

## 2. Compaction

### 2.1 Purpose

- Replace long conversations/many tool calls with “summary” so you can continue working
- Automatically before crossing the model's context window

### 2.2 Configuration (CompactionConfig)

```ts
export type CompactionConfig = {
  enabled?: boolean;         // default true
auto?: boolean; // default true (if false, suppress automatic compaction)
  thresholdRatio?: number;   // default 0.8
model?: string | null; // optional: model to use for summarization
summaryPrompt?: string; // default: Compliant with Python version (<summary> tag)
summaryDirectives?: string[]; // optional: Additional instructions when summarizing (append)
retainPrompt?: string | null; // optional: retain instruction (<retain> tag)
retainDirectives?: string[]; // optional: retain append
retainLastTurns?: number; // default 1 (retains the last N turns)
};
```

### 2.3 Token Usage

Follow the calculations in the Python version:

- total = input + cache_creation + cache_read + output

```ts
export type TokenUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  total_tokens: number; // computed
};
```

Being able to create `TokenUsage` from `ChatInvokeUsage`.

### 2.4 Determining the context limit

- Use if you can get `max_input_tokens` or `max_tokens` from price/model information
- Error (strict) if it cannot be obtained. The premise is to obtain metadata externally and enrich the registry.

threshold = contextLimit * thresholdRatio

### 2.5 shouldCompact

- `enabled=false` → false
- `auto=false` → false (automatic determination is disabled)
- `tokenUsage.total_tokens >= threshold` → true

### 2.6 compact (generate summary)

Steps to generate a summary:

1. “Format” messages for summaries
2. Add interrupt message (retain+summary instruction) to the end as `UserMessage`
3. Call LLM without tool (`tools=null`)
4. Extract `<retain>...</retain>` and `<summary>...</summary>` from the returned text
5. Interrupt messages and LLM responses are not recorded in history

#### 2.6.1 Formatting for summaries (important)

In the Python version, if you include “the state in which the trailing assistant has tool_calls” in the summary, the tool/result correspondence will break and an API error will occur, so remove the trailing assistant tool_calls.

The TS version does the same thing:

- If messages ends with `AssistantMessage(tool_calls!=empty)`:
- If `content` is present, replace it with “AssistantMessage without tool_calls (content only)”
- If `content` is not present, drop the message (do not include it in the summary)

#### 2.6.2 Preference for compaction.model

When generating a summary, `CompactionConfig.model` is given priority and LLM is selected.

- If `model` is specified: summary calls use that model
- If `model` is `null`/unspecified: Use normal LLM (caller's model)

Usage: Summarize with a low-cost model / Summarize with a model that can handle long contexts.

#### 2.6.3 summaryDirectives (additional instructions)

If `summaryDirectives` exists, add it as a bulleted list at the end of the summary prompt.
It is assumed that it will be used to "add instructions to leave important information" without replacing the existing prompt.

#### 2.6.4 retainPrompt / retainDirectives

If `retainPrompt` is present, use it to indicate the `<retain>` section in the interrupt message.
Add `retainDirectives` in bullet points.
Usage: Enumerate information that should be retained (tool output refs and important decisions).

### 2.7 checkAndCompact (History replacement)

If compaction is triggered:

- Replace the entire history with “retain + summary + last N turns”
- retain is inserted at the beginning as `UserMessage`
- summary should be `UserMessage(content=summary)`
- If `retainLastTurns` exists, leave the most recent N turns

#### 2.7.1 Rebuilding the provider-specific history cache

In implementations with provider-specific history buffers, such as OpenAI, after compaction
Rebuild the "history cache used for sending" from `compactedMessages`.

- Just replacing view messages does not shorten the sending history
- `inputItems` of OpenAIHistoryAdapter converts `compactedMessages` back
- Previous provider output items are not consistent with the summarized history and are therefore discarded.

### 2.8 Inclusion in the Agent loop

Following the timing of the Python version:

- Can perform compaction judgment after each LLM call (after usage is taken)
- Call compaction after tool execution (however, “last usage” is used for judgment)
- Pass compaction once just before finishing (before final return)

---

## 3. Checkpoints to implement while learning

The first implementation does not need a “real token count” (just return a fixed value in MockModel).

1. Ability to trim old output when tool output cache exceeds total size limit
2. Trimmed ToolMessage becomes placeholder in serializer
3. When compaction exceeds threshold, replace history with retain + summary
4. It is possible to reproduce in a test the phenomenon that the tool_calls of assistant at the end are not removed or it breaks.
