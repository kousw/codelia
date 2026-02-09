# Package Architecture Spec（Target Architecture）

This document defines the **goal architecture** for Codelia.
Adopt a design that prioritizes long-term operation, scalability, and safety over the convenience of existing implementation.

---

## 1. Purpose

1. Clear separation between library usage and app usage
2. Fix the direction of dependence and prevent responsibilities from blurring
3. Keep the UI (Rust TUI / future Desktop) and execution system loosely coupled
4. Consolidate security boundaries (sandbox/permission/auth) into runtime
5. Specify in a way that allows for gradual migration

---

## 2. Design principles

### 2.1 One-way dependence
Upper layers only depend on lower layers. Reverse dependence is prohibited.

### 2.2 Core Minimization
`core` contains only the Agent's domain logic.
It does not have file I/O, authentication, RPC, or OS-dependent processing.

### 2.3 Wire Contract Independence
`protocol` does not depend on the internal type of `core`.
The wire type is defined with `protocol` or `shared-types` and does not depend on the core implementation type.

### 2.4 Runtime focus
`runtime` centrally manages "boundary functions necessary for actual operation" (tool/sandbox/permission/auth/session/rpc/mcp).

### 2.5 App thinning
`cli` and `tui` limit their responsibilities to display, input, and process startup, and have no business logic.

### 2.6 Normalization of output contracts
The model output is passed to core as an ordered sequence of `BaseMessage[]`, not as a fragment representation for each provider.
The Agent processes the returned `BaseMessage[]` in order without re-aggregating it (the basis for future stream processing).
Call metadata such as `usage` is treated as an auxiliary field separate from the message column.

---

## 3. Layer structure

```text
Applications
  - @codelia/cli
  - crates/tui

Runtime Host
  - @codelia/runtime

Integration
  - @codelia/storage
  - @codelia/config-loader
  - @codelia/model-metadata
- @codelia/providers-* (future separation)

Domain
  - @codelia/shared-types
  - @codelia/core
  - @codelia/config
  - @codelia/protocol
```

Basic form of dependence:

```text
cli/tui -> runtime -> core
runtime -> protocol, storage, config-loader, model-metadata
config-loader -> config
storage -> core(type) or shared-types
protocol -> shared-types
```

---

## 4. Package responsibilities

### 4.1 `@codelia/core`

Responsibilities:
- Agent loop（run/runStream）
- Tool contract（defineTool / Tool / ToolContext）
- History management abstraction
- compaction / tool-output-cache / usage aggregate domain services
- provider abstract interface

Prohibited:
- RPC implementation
- auth / permission
- sandbox / filesystem operations
-storage implementation
- UI dependent

Note:
- OpenAI/Anthropic implementation will be separated into `providers-*` in the future
- Even if they will coexist for the time being, clearly define the import boundaries and separate the public API of `core`

### 4.2 `@codelia/protocol`

Responsibilities:
- JSON-RPC envelope
- wire schema in initialize/run/session/model/ui-request
- version/capabilities

Prohibited:
- Dependency on core internal types
- runtime implementation code

Note:
- Cross-boundary types such as `agent.event` / `session.list` can refer to `shared-types`
- protocol does not depend on core/runtime/storage

### 4.2.5 `@codelia/shared-types`

Responsibilities:
- Single sourcing types that require cross-boundary long-term compatibility (e.g. `AgentEvent`, `SessionStateSummary`)

Prohibited:
- Depends on other workspace packages
- provider/runtime Inclusion of internal types for implementation reasons

### 4.3 `@codelia/runtime`

Responsibilities:
- composition root of Agent
- Standard tools (bash/read/write/edit/grep/glob/todo/done)
- MCP client manager (external MCP server connection/initialization/call mediation)
- sandbox/path guard
- permission policy
- auth（API key / OAuth）
- session lifecycle, cancel, busy control
- protocol server（stdio JSON-RPC）

Prohibited:
- UI display logic
- In-house creation of protocol type definition (must use `@codelia/protocol`)

Required operation:
- Single run execution control (run queue or mutex)
- `getAgent` initialization singleflight
- Guaranteed persistence and failure logs at the end of a run

### 4.4 `@codelia/storage`

Responsibilities:
- SessionStore / SessionStateStore / ToolOutputCacheStore implementation
- Provide RunEventStoreFactory / SessionStateStore entity (DI to runtime)
- storage layout solved

Prohibited:
- runtime state management
- UI dependent

contract:
- runtime does not directly implement `storage` and `new`
- runtime depends on `RunEventStoreFactory` / `SessionStateStore` interface
- Separate append-only run event storage and session snapshot storage

### 4.5 `@codelia/config` / `@codelia/config-loader`

`config`:
- Schemas, defaults, types

`config-loader`:
- File search/load/merge
- writing helper

### 4.6 `@codelia/model-metadata`

Responsibilities:
- Model metadata retrieval and caching
- Provided to runtime/core

Prohibited:
- Intervening in Agent loop

### 4.7 `@codelia/cli`

Responsibilities:
- entry point
- TUI launch or fallback launch

Prohibited:
- tool implementation redefinition
- Duplicate implementation of Agent construction logic

Note:
- Move the current equivalent of `basic-cli` to `examples/` and separate it from the product CLI.

### 4.8 `crates/tui`

Responsibilities:
- Screen drawing and user input
- runtime child process management
- protocol communication

Prohibited:
- Reimplement domain logic

---

## 5. Dependency rules (forced)

1. `protocol` does not depend on `core`
2. `shared-types` does not depend on other workspace packages
3. `cli` directly uses `runtime` and does not call `core` directly (product path)
4. Only runtime has standard tools
5. Sandbox is exclusive to runtime. Do not backflow to core/tools contract
6. Don't ignore storage write failures; at least record them in the runtime log.
7. Generate run event storage via factory and hide implementation details from runtime

---

## 6. Execution pattern

### 6.1 Library Embed (minimum)
- Users use `core` directly and combine their own tools/storage
- This is an SDK use case

### 6.2 Runtime Embed (recommended)
- User starts `runtime` as a server and uses it via `protocol`
- Standard tools/sandbox/permission/auth available

### 6.3 End-user App
- Use `cli -> tui -> runtime` route as standard
- Separate CLI as "UI launcher" and runtime as "execution engine"

---

## 7. Directory Policy

```text
packages/
  shared-types/
  core/
  protocol/
  runtime/
  storage/
  config/
  config-loader/
  model-metadata/
  cli/
examples/
basic-cli/ # core Direct use sample (separated from product conductor)
crates/
  tui/
```

---

## 8. Migration plan (phased)

### Phase 1: Fixed boundaries
1. Confirm dependent rules according to `package-architecture`
2. Remove implementation logic (tools/agent construction) from `cli` and send it via runtime
3. Move `basic-cli` to `examples/`
4. Abolish SessionStore direct `new` in runtime and change to factory injection

### Phase 2: Contractual Independence
1. Remove core dependency of protocol
2. Move cross-boundary common types to shared-types (eliminate duplication of protocol/core)

### Phase 2.5: Unification of LLM output contract
1. Migrate `BaseChatModel.ainvoke` to `BaseMessage[] + meta` contract
2. Agent processes in order loop of `BaseMessage`
3. `llm.response.output` in the session record has `messages` as its only canonical representation

### Phase 3: Safety and concurrency
1. `getAgent` singleflight runtime
2. Serialize run.start with mutex/queue
3. Introducing sandbox symlink entity resolution check

### Phase 4: Module organization
1. Separation of provider implementations (`providers-openai` / `providers-anthropic` etc.)
2. Gradually expand the target types of shared-types

---

## 9. Acceptance conditions

1. All package dependencies align with the direction of this specification.
2. `cli` does not have a tool implementation in the product lead
3. Protocol can be built without core dependence
4. runtime has single run control and explicit error logging
5. Both `core` standalone usage and `runtime` usage are maintained.

---

## 10. Position of this specification

This document represents the **North Star** of implementation.
Even if there are items that have not been achieved in the short term, new changes should be made in this direction.
