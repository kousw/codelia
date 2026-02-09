# Tools Spec（defineTool / zod / DI / serialization / tool output cache）

This document is a specification for the definition, execution, and schema generation of Tool (function tool).
We aim for the “minimum and correct form” when converting the Python version of `@tool` and `Depends` to TS.

---

## 1. Terminology

- Tool: A function that the model can call with tool call. Input is JSON (constrained by schema)
- Tool definition: "Tool list" (name/description/JSON Schema) to be passed to LLM
- DI: A mechanism to resolve and inject dependencies (DB clients, etc.) when running the tool

---

## 2. Basic form of Tool (recommended)

### 2.1 defineTool

In TS, the “data + function” form is easier to handle than the decorator.

```ts
export type DefineToolOptions<TInput, TResult> = {
  name: string;
  description: string;
  input: ZodSchema<TInput>;
  execute: (input: TInput, ctx: ToolContext) => Promise<TResult> | TResult;
};

export type Tool = {
  name: string;
  description: string;
definition: ToolDefinition; // parameters are JSON Schema
  executeRaw: (rawArgsJson: string, ctx: ToolContext) => Promise<ToolResult>;
};
```

By moving `executeRaw` to the Tool side, the Agent side can

- JSON parse
- Validation
- Exception → ToolMessage

can be treated as a “Tool common” implementation.

### 2.2 ToolContext (DI receptacle)

```ts
export type ToolContext = {
  signal?: AbortSignal;
  logger?: Logger;
  now?: () => Date;

  // dependency overrides / injection
  deps: Record<string, unknown>;
  resolve: <T>(key: DependencyKey<T>) => Promise<T>;
};
```

Tool extracts dependencies using `ctx.resolve(...)` (or you can directly reference `ctx.deps`).

---

## 3. JSON Schema generation (zod → JSON Schema)

### 3.1 Purpose

- Enable LLM to produce “correct argument form”
- Validate invalid arguments before tool execution (zod validate)

### 3.2 Requirements

- Ability to generate JSON Schema from zod schema
- Must be able to attach constraints equivalent to `additionalProperties: false` (If not, reject on the Tool side)
- When using OpenAI strict tool calling, meet “strict compatibility” (see providers spec for details)

*Use Zod v4's `toJSONSchema` (`target: "draft-07"` / `io: "input"`).

---

## 4. DI (equivalent to Depends) specifications

Properties that the Python version of `Depends` satisfies:

- Dependencies can be resolved with either sync/async
- Can be overridden (replaced)

In TS, it is easy to understand that the “dependency resolution key” is explicitly specified and handled.

### 4.1 DependencyKey

```ts
export type DependencyKey<T> = {
  id: string;
  create: () => T | Promise<T>;
};

export type DependencyOverrides = Map<string, () => unknown | Promise<unknown>>;
```

### 4.2 Resolve rules

- If `overrides` has the same `id`, use it
- If not, call `create()`
- Values may be cached for the duration of a single tool call (“per-run” caching if necessary)

CLI is often used to replace ``file operation root'' and ``work directory'' with DI.

---

## 5. Tool result expression and serialization

### 5.1 ToolResult (internal representation)

```ts
export type ToolResult =
  | { type: 'text'; text: string }
  | { type: 'parts'; parts: (TextPart | ImagePart)[] }
  | { type: 'json'; value: unknown };
```

### 5.2 ToolMessage conversion rules

- `text` → `ToolMessage.content` is string
- `json` → JSON.stringify (for stability)
- `parts` → `ToolMessage.content` are parts

### 5.3 Exception

Tool exceptions are converted to `ToolMessage(is_error=true, content="Error executing tool: ...")`.

---

## 6. Tool output cache

While tool output is "kept in context as much as possible", if the total size limit is exceeded,
Trim from old output and leave reference ID. See `docs/specs/context-management.md` for details.

ToolMessage may be given `output_ref` (reference ID).

TODO:
- Implementation of tool_output_cache / tool_output_cache_grep supports streaming in case of large output.
- For tool output cache, consider a method to fully save content parts (image/document, etc.)

---

## 7. Positioning of “standard tools”

### 7.1 done

- `done` is recommended as a “termination tool”
- Not required (normally ends with response without tool call)

### 7.2 planning（todos）

Planning (`write_todos`, etc.) is not required for core, but is provided as a standard CLI tool.

With this design:

- Library usage can be kept to a minimum
- Using CLI can reduce the volatility of plans

### 7.3 tool_output_cache

Standard tool to get the contents from the reference ID of the tool output cache.

- name: `tool_output_cache`
- input: `{ ref_id: string, offset?: number, limit?: number }`
- output: text with line numbers (similar to `read`)

### 7.4 tool_output_cache_grep

A standard tool that searches against the reference ID of the tool output cache.

- name: `tool_output_cache_grep`
- input: `{ ref_id: string, pattern: string, regex?: boolean, before?: number, after?: number, max_matches?: number }`
- output: text with line numbers (similar to `grep`)

---

## 8. Edit tool (enhanced behavior)

The `edit` tool semantics are defined in `docs/specs/edit-tool.md`.
