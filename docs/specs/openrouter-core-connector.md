# OpenRouter Core Connector Split Spec

## 0. Status

- Status: Implemented
- Date: 2026-02-21
- Related: `docs/specs/openrouter.md`

This document records the connector split from runtime-level `ChatOpenAI` reuse to a dedicated core `ChatOpenRouter` adapter.

## 1. Problem Statement (pre-split)

Current behavior works, but architecture is mismatched:

- OpenRouter runtime path is represented as `ChatOpenAI`, so provider identity in core is `openai`.
- OpenRouter-specific execution behavior is split between runtime and OpenAI adapter assumptions.
- Provider-level diagnostics and future OpenRouter-specific request extensions are harder to implement safely.

## 2. Goals

- Move OpenRouter invocation implementation into `@codelia/core` as a dedicated adapter.
- Keep runtime as composition/auth/orchestration layer, not provider implementation owner.
- Preserve existing run behavior (Responses API streaming, tool serialization, compaction compatibility).
- Keep migration low risk and incremental.

## 3. Non-goals (this phase)

- Replacing runtime auth/model listing logic (`OPENROUTER_API_KEY`, `/models`) in this change.
- Full support for all OpenRouter routing/provider-preference fields.
- Changing protocol shape or TUI behavior.

## 4. Target Architecture

### 4.1 Core adapter

Add `ChatOpenRouter` in core:

- File: `packages/core/src/llm/openrouter/chat.ts`
- Contract: `BaseChatModel<"openrouter", OpenRouterInvokeOptions>`
- Transport: OpenAI SDK Responses path (`responses.stream(...).finalResponse()`)
- Default base URL: `https://openrouter.ai/api/v1`
- Optional headers: `HTTP-Referer`, `X-Title`
- Model/reasoning/verbosity options remain compatible with current OpenRouter runtime path.

### 4.2 Shared Responses API baseline + provider-specific behavior

OpenAI/OpenRouter should share only the common baseline defined by the Responses API contract, but must not be forced into identical behavior when provider-specific needs diverge.

This "shared baseline" is strictly limited to the Responses API framework and does not imply cross-provider unification of non-Responses or vendor-specific behavior.

Shared Responses API baseline scope:

- Message/tool serialization for provider-neutral fields.
- Completion normalization for tool-call/function-call-output/history reconstruction.
- Common streaming/final-response control flow.

Provider-specific scope (allowed and expected):

- OpenAI-only request fields/headers and compatibility behaviors.
- OpenRouter-only request fields/headers and compatibility behaviors.
- Future provider-specific retries/error mapping/feature flags.

Implementation strategies:

- Prefer extracting shared helpers for baseline behavior.
- If duplication is kept, enforce baseline parity tests and keep provider-specific tests separate.

Requirement: tool-call/function-call-output/history semantics stay equivalent by default, except when explicitly declared as provider-specific in spec and tests.

### 4.3 Runtime responsibility after split

Runtime keeps:

- Provider selection and auth prompt/env resolution.
- OpenRouter model listing (`GET /models`) and `model.set` pass-through behavior.
- Onboarding flow and model config persistence.

Runtime changes:

- Instantiate `ChatOpenRouter` (not `ChatOpenAI`) when `model.provider === "openrouter"`.
- Stop embedding OpenRouter transport details in runtime-specific OpenAI adapter wiring where possible.

## 5. Public API / Export Changes

- Add export in `packages/core/src/index.ts`:
  - `export { ChatOpenRouter } from "./llm/openrouter/chat";`
- Keep existing `ChatOpenAI` and `ChatAnthropic` exports unchanged.

No protocol-level changes are required.

## 6. Compatibility Requirements

- Existing `model.provider = "openrouter"` configs continue to run without migration.
- `model.list(provider=openrouter)` and `model.set(provider=openrouter)` behavior remains unchanged.
- Hosted search serialization remains compatible with provider tags `openai` and `openrouter`.
- OpenRouter keeps non-strict model registry handling in runtime (`strict: false` path stays as-is unless separately specified).

## 7. Diagnostics / Logging Requirements

- OpenRouter runs should be logged as provider `openrouter` in provider diagnostics output.
- Existing debug/dump behavior must remain available and should not leak secrets.

## 8. Testing Plan

### 8.1 Core tests

- Add adapter tests covering:
  - Provider identity (`openrouter`).
  - Baseline parity for tool serialization and history conversion.
  - Explicit provider-specific behavior tests (OpenAI-only / OpenRouter-only) so intentional divergence is documented.
  - Optional header forwarding behavior.

### 8.2 Runtime tests

- Add/adjust factory tests to verify `openrouter` branch uses `ChatOpenRouter`.
- Keep existing OpenRouter model-list tests green.

### 8.3 Regression checks

- Run focused tests for `@codelia/core` and `@codelia/runtime`.
- Run workspace typecheck.

## 9. Rollout Steps

1. Land this spec and implementation plan.
2. Implement core adapter + runtime wiring switch.
3. Add tests and run verification.
4. Update `docs/specs/openrouter.md` status from "planned connector" to "implemented connector" once merged.
