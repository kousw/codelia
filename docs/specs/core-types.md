# Core Types Spec (common types/compatibility)

This document defines the "common types (data shapes handled by the core)" for the TypeScript version of Agent SDK.

The purpose is twofold.

1. Make the Agent loop **insensitive to provider differences**
2. Make Tools / Message / Usage / Events **Testable** and **Extensible**

---

## 1. Basic policy of compatibility

- Core (Agent) only sees "common types"
- OpenAI / Anthropic / Gemini differences are absorbed by `providers/*`
- The return value/form that is left in the history allows additional fields in the future (`meta?: unknown`, etc.)

Implementation arrangement:
- `packages/core/src/types/llm/*`（messages / tools / invoke）
- `packages/core/src/types/events/*`（AgentEvent）

---

## 2. Message type

### 2.1 Role

```ts
export type Role = 'system' | 'user' | 'assistant' | 'tool';
```

### 2.2 Content Parts (Multimodal)

Tool result or user input can be "text + image" etc., so content accepts string or parts array.

```ts
export type TextPart = { type: 'text'; text: string };

export type ImagePart = {
  type: 'image_url';
  image_url: {
url: string; // data URL or https URL
    detail?: 'auto' | 'low' | 'high';
    media_type?: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  };
};

export type DocumentPart = {
  type: 'document';
  source: {
    data: string;             // base64
    media_type: 'application/pdf';
  };
};

export type ContentPart = TextPart | ImagePart | DocumentPart;
```

### 2.3 BaseMessage

```ts
export type UserMessage = {
  role: 'user';
  content: string | ContentPart[];
  name?: string;
};

export type SystemMessage = {
  role: 'system';
  content: string | TextPart[];
  name?: string;
cache?: boolean; // For prompt caching such as Anthropic (only valid for compatible providers)
};

export type AssistantMessage = {
  role: 'assistant';
content: string | null; // null is also acceptable for only tool calls
  name?: string;
  tool_calls?: ToolCall[];
  refusal?: string | null;
};

export type ToolOutputRef = {
  id: string;
  byte_size?: number;
  line_count?: number;
};

export type ToolMessage = {
  role: 'tool';
  tool_call_id: string;
  tool_name: string;
content: string | (TextPart | ImagePart)[]; // tool can be assumed not to return document (extend if necessary)
  is_error?: boolean;
output_ref?: ToolOutputRef; // tool output cache reference
trimmed?: boolean; // “Content trimmed”
};

export type BaseMessage =
  | UserMessage
  | SystemMessage
  | AssistantMessage
  | ToolMessage;
```

Note:
- Even in the case of `trimmed`, it can be expanded from `output_ref`.

---

## 3. Tool calls / Tool definitions

### 3.1 ToolCall

```ts
export type ToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;  // JSON string
  };
provider_meta?: unknown; // Retain any additional information required by Gemini etc.
};
```

### 3.2 ToolDefinition (“tool” passed to LLM)

```ts
export type ToolDefinition = {
  name: string;
  description: string;
parameters: JSONSchema7; // Adopts Draft-07 of json-schema (zod → conversion)
strict?: boolean; // Be aware of OpenAI strict (true recommended)
};
```

### 3.3 ToolChoice (How LLMs choose tools)

```ts
export type ToolChoice = 'auto' | 'required' | 'none' | string; // string forces tool name
```

---

## 4. Common return values for LLM calls

```ts
export type ChatInvokeUsage = {
  model: string;
  input_tokens: number;
  input_cached_tokens?: number | null;
  input_cache_creation_tokens?: number | null; // Anthropic only
  input_image_tokens?: number | null;          // Gemini only
  output_tokens: number;
  total_tokens: number;
};

export type ChatInvokeCompletion = {
  messages: BaseMessage[];        // normalized output sequence from provider
  usage?: ChatInvokeUsage | null;
  stop_reason?: string | null;    // end_turn / tool_use / max_tokens etc
  provider_meta?: unknown;        // provider-specific metadata
};
```

Note:
- Implemented: text/tool_calls/reasoning is expressed as `messages` (ordered)
- Implemented: Agent determines whether to continue using the `tool_calls` number extracted from assistant message.
- Planned: `redacted_reasoning` dedicated field not introduced (will be expanded when necessary)

---

## 5. Agent events (for runStream)

Events should be unioned in a determinable way so that the UI/CLI can show you what it is “doing.”

```ts
export type TextEvent = { type: 'text'; content: string; timestamp: number };
export type ReasoningEvent = { type: 'reasoning'; content: string; timestamp: number };

export type StepStartEvent = {
  type: 'step_start';
  step_id: string;
  title: string;
  step_number: number;
};

export type ToolCallEvent = {
  type: 'tool_call';
  tool: string;
  args: Record<string, unknown>;
  tool_call_id: string;
  display_name?: string;
};

export type ToolResultEvent = {
  type: 'tool_result';
  tool: string;
  result: string;
  tool_call_id: string;
  is_error?: boolean;
  screenshot_base64?: string | null;
};

export type StepCompleteEvent = {
  type: 'step_complete';
  step_id: string;
  status: 'completed' | 'error';
  duration_ms: number;
};

export type HiddenUserMessageEvent = { type: 'hidden_user_message'; content: string };

export type FinalResponseEvent = { type: 'final'; content: string };

export type AgentEvent =
  | TextEvent
  | ReasoningEvent
  | StepStartEvent
  | ToolCallEvent
  | ToolResultEvent
  | StepCompleteEvent
  | HiddenUserMessageEvent
  | FinalResponseEvent;
```

Compatibility notes:
- Compliant with Python version `events.py` (issue step start/complete for UI)
- token-by-token streams are not a core requirement (extend with provider if needed)
