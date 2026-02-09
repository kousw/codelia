# packages/ Refactor priority arrangement (2026-02-08)

## the purpose
`packages/` Organize the enlarged points under `packages/` from the viewpoint of separation of responsibilities, readability, and separation of dependencies, and create a backlog with execution order.

## Investigation Snapshot
- TS implementation scale (`src/`)
  - `@codelia/runtime`: 44 files / 6,923 lines
  - `@codelia/core`: 45 files / 3,759 lines
  - `@codelia/cli`: 1 file / 1,160 lines
- Equivalent to `@codelia/mcp` (in runtime): 5 files / 2,040 lines
- Huge file
- `packages/cli/src/index.ts` 1,160 lines
- `packages/runtime/src/mcp/manager.ts` line 929
- `packages/core/src/agent/agent.ts` line 782
- `packages/runtime/src/mcp/client.ts` line 631
- `packages/runtime/src/rpc/run.ts` 550 lines
- Concerns about dependence and boundaries
- `@codelia/model-metadata` declares `@codelia/protocol` as dependent, but it is unused in `src/`
- `runtime` is deep importing to `@codelia/core/types/llm/messages` (dependency across public API boundaries)
- MCP protocol constants and handshake processing are duplicated in `cli` and `runtime`

## Priority criteria
- `P0`: There is a high risk of conflict/regression when adding features, and the effect is greater if started early.
- `P1`: Structural debt that you want to separate systematically in the next development cycle
- `P2`: Low risk, but effective with continuous operation

## Refactor suggestions with priority

### P0-1: CLI Single File Responsibility Separation
- Status: Fixed (2026-02-08 phase1/phase2/phase3 implemented)
- Target: `packages/cli/src/index.ts`
- Mixed current situation
- TUI start (`runTui`)
  - MCP config CRUD (`runMcpCommand`)
- MCP auth token management (`runMcpAuthCommand`)
- MCP communication test (HTTP/stdio probe)
- suggestion
- Split into `src/commands/mcp/*.ts`, `src/tui/launcher.ts`, `src/mcp/probe.ts`, `src/args.ts`
- MCP auth file I/O is shared with runtime's `mcp/auth-store`
- Implementation details (phase 1)
- Changed `src/index.ts` to a thin dispatcher
- Separate MCP command group into `src/commands/mcp.ts`
- Separate TUI startup processing to `src/tui/launcher.ts`
- Added `packages/cli/tests/mcp-protocol.test.ts`
- Implementation details (phase 2)
- Added `src/args.ts` and replaced argument handling with `cac` base
- Separate MCP protocol judgment into `src/mcp/protocol.ts`
- Separate MCP communication test processing to `src/mcp/probe.ts`
- Separate MCP auth file I/O to `src/mcp/auth-file.ts`
- Added `packages/cli/tests/args.test.ts`
- Implementation details (phase 3)
- Make `src/commands/mcp.ts` a thin dispatcher and separate responsibilities into `src/commands/mcp-config.ts` / `src/commands/mcp-auth.ts`
- Share MCP auth file I/O implementation from `@codelia/storage` to `McpAuthStore` (use the same implementation in runtime/cli)
- Expected effect
- Reduced influence range when adding commands
- Shift to a structure that makes it easier to introduce unit tests

### P0-2: Runtime MCP layer division (manager/client/oauth)
- Status: Fixed (2026-02-08)
- subject
  - `packages/runtime/src/mcp/manager.ts`
  - `packages/runtime/src/mcp/client.ts`
  - `packages/runtime/src/mcp/oauth.ts`
- Mixed current situation
- Connection lifecycle
  - OAuth metadata discovery/refresh
- tool adapter generation
  - HTTP/stdio JSON-RPC transport
- suggestion
- Separate `manager` into "connection state management", "OAuth token management", and "tool adapter generation"
- Separate `client` into `stdio-client` / `http-client` / `jsonrpc helpers`
- MCP protocol version and compatibility determination logic shared module (common with CLI)
- Implementation details
- Separate pure helper of `manager.ts` into `tooling.ts` (tool adapter/list acquisition) and `oauth-helpers.ts` (metadata discovery/token parse)
- Split `client.ts` into `stdio-client.ts` / `http-client.ts` / `jsonrpc.ts` / `sse.ts`, and dilute `client.ts` to only contracts and re-exports.
- Consolidate MCP protocol version judgment into `@codelia/protocol/src/mcp-protocol.ts` and eliminate duplicate implementation of runtime/cli.
- Added `packages/protocol/tests/mcp-protocol.test.ts` and fixed common protocol helper for testing
- Expected effect
- Reduced risk of regression when adding MCP functions (auth/state/tool expansion)
- Reduced duplicate implementation of runtime and CLI

### P0-3: Immediate correction of dependency boundaries (low cost)
- Status: Fixed (2026-02-08)
- subject
  - `packages/model-metadata/package.json`
  - `packages/runtime/src/rpc/run.ts`
  - `packages/core/src/index.ts`
- Implementation details
- Removed unused dependency `@codelia/protocol` from `@codelia/model-metadata`
- Export `BaseMessage` in `@codelia/core` and replace deep import in runtime/tests
- Added `scripts/check-workspace-deps.mjs` to detect workspace-dependent unused/undeclared and deep imports.
- Added `bun run check:deps` to CI (`.github/workflows/ci.yml`)
- suggestion
- Removed unused dependency `@codelia/protocol` from `@codelia/model-metadata`
- Re-export `BaseMessage` to `@codelia/core` public API and abolish deep import
- Added CI script to detect unused/undeclared dependencies within workspace
- Expected effect
- Dependency graph noise reduction
- Early detection of package boundary destruction

### P0-4: Simplification by using libraries (precedent)
- Status: Fixed (2026-02-08)
- subject
  - `packages/runtime/src/mcp/sse.ts`
  - `packages/runtime/src/mcp/oauth.ts`
  - `packages/cli/src/commands/mcp-config.ts`
  - `packages/cli/src/args.ts`
- Implementation details
- Replaced SSE parsing from handwritten implementation to `eventsource-parser` base
- Replaced MCP OAuth PKCE/state generation with `oauth4webapi`
- CLI MCP config normalization declared in `zod` schema
- Simplify the return value wrapping of `cac` and organize it to `options` direct reading base.
- Added regression tests: `packages/cli/tests/mcp-config.test.ts` / `packages/runtime/tests/mcp-http-client.test.ts` (chunk boundary case)
- Expected effect
- Suppress reinvention of specifications/boundary condition correspondence
- Improved readability and maintainability around parsing/validation

### P1-1: Repartition of runtime composition root
- Target: `packages/runtime/src/agent-factory.ts`
- Mixed current situation
- sandbox initialization
- AGENTS resolver initialization
-Tools construction
- model/auth resolution
  - permission confirm UI
- Agent instance assembly
- suggestion
- Split into `agent/bootstrap.ts`, `agent/provider-factory.ts`, `agent/permission-gateway.ts`, `agent/toolset.ts`
- OAuth UI wait processing is extracted to `mcp/oauth-ui.ts`
- Expected effect
- Improved readability of boot path
- Loose coupling between UI confirmation flow and domain assembly

### P1-2: Standardization of config operations (runtime/cli deduplication)
- subject
  - `packages/runtime/src/config.ts`
  - `packages/cli/src/index.ts`
  - `packages/config-loader/src/index.ts`
- Mixed current situation
- JSON raw read/write, version verification, partial update logic distributed in multiple locations
- suggestion
- Consolidate config update helper to `config-loader` side (model/mcp/permissions update API)
- runtime/cli reduced to only "use case call"
- Expected effect
- Consolidate correction points in one place when changing setting specifications
- Simplify the test target

### P1-3: Phase separation of provider implementation from core
- subject
  - `packages/core/src/llm/*`
  - `packages/core/src/index.ts`
- background
- The provider separation policy has been specified in the `package-architecture` specification.
- There are 1,148 lines of `llm` in core, and SDK dependencies remain in the domain layer.
- suggestion
- Added `@codelia/providers-openai` / `@codelia/providers-anthropic`
- Leave only `BaseChatModel` contract and minimum implementation in `core`
- The compatibility period is a step-by-step transition from `@codelia/core` by re-export.
- Expected effect
- Core responsibility purification
- Localized impact when adding provider

### P2-1: Duplicate integration of OAuth utilities
- subject
  - `packages/runtime/src/auth/openai-oauth.ts`
  - `packages/runtime/src/mcp/oauth.ts`
- current situation
- PKCE/state generation, callback waiting, and basic processing of HTML response are duplicated
- suggestion
- Standardize `runtime/auth/oauth-utils.ts` (PKCE/state/callback server)
- Expected effect
- Reduce duplication of authentication bug fixes

### P2-2: Integrating message/content stringification helper
- subject
  - `packages/core/src/agent/agent.ts`
  - `packages/runtime/src/rpc/run.ts`
  - `packages/storage/src/session-state.ts`
- current situation
- Conversion of `ContentPart[] -> string` system slightly diverges due to multiple implementations.
- suggestion
- Useful (user display/log) helpers as common modules
- Expected effect
- Prevent unexpected discrepancies in display differences and log differences

### P2-3: Add minimum cover for test blank package
- Target: `cli`, `model-metadata`, `protocol`, `shared-types`, `storage`
- suggestion
- First introduce a small snapshot/contract test to create a safety net for P0/P1 refactors
- Expected effect
- Improved regression resistance against structural changes

## Implementation order (recommended)
1. `P0-3` (immediate correction of dependency boundaries)
2. `P0-1` (CLI split)
3. `P0-2` (runtime MCP split)
4. `P0-4` (Simplification using library)
5. `P1-1` + `P1-2` (organizing runtime configuration/setting responsibilities)
6. `P1-3` (provider separation)
7. `P2` group (redundant integration and test reinforcement)

## Completion conditions (how to use this document)
- Create `plan/YYYY-MM-DD-*.md` for each item and implement it in stages
- Progress one item at a time and check the regression with `bun run typecheck` and the corresponding package test
