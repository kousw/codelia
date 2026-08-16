# Provider Retry and Failure Policy

This document records the implemented common provider retry/failure policy and the
remaining transport-watchdog work for rate limits, overload, timeouts, cancellation,
and safe error reporting.
It separates retry policy from provider serialization and from the TUI rendering
of retry progress.

Official provider documentation was last checked on 2026-07-19. Provider limits
and error vocabularies can change independently of Codelia, so the source links in
section 5 are part of the maintenance contract rather than background reading.

## 1. Status

Status: `Partial` — shared classification, bounded retry window, retry
progress, and normal runtime/session redaction are implemented as of 2026-08-01;
first-byte/stream-idle watchdogs and a stream-first internal model boundary remain.

Scope: all six providers currently exposed by runtime auth/model selection:
OpenAI, Anthropic, OpenRouter, Moonshot, Z.ai, and xAI. `ProviderName` also retains
a `google` member for shared type compatibility, but there is no Google chat
adapter or runtime-selectable Google provider in this baseline, so it has no
retry mapping here.

### 1.1 Current behavior (implemented)

Codelia owns retry attempts at the `Agent.runStream()` model-step boundary. Each
provider supplies a pure classifier, Core owns delay/window/cancellation policy,
and runtime persists only safe structured provider failures.

Runtime defaults are:

| Setting | Default |
| --- | ---: |
| Total attempts | 3 (2 retries) |
| Base backoff | 1 second |
| Maximum backoff | 60 seconds |
| Maximum accepted provider wait hint | 60 seconds |
| Window for starting another retry, including waits | 20 minutes |

OpenAI, OpenRouter, Moonshot, xAI, and Anthropic clients constructed by Codelia set
SDK `maxRetries: 0`, preventing a hidden retry loop underneath Core. Z.ai already
uses the Codelia fetch transport without SDK retry. Explicit caller-injected SDK
clients remain caller-owned and must disable their own retry policy.

Current wire modes are not the same as the Core API boundary:

| Provider path | Provider wire mode | What `Agent` receives |
| --- | --- | --- |
| OpenAI HTTP / WebSocket | streaming events | one accumulated `ChatInvokeCompletion` promise |
| OpenRouter | streaming events | one accumulated `ChatInvokeCompletion` promise |
| Moonshot | streaming events | one accumulated `ChatInvokeCompletion` promise |
| xAI | streaming events | one accumulated `ChatInvokeCompletion` promise |
| Z.ai | streaming SSE | one accumulated `ChatInvokeCompletion` promise |
| Anthropic | non-streaming message create | one `ChatInvokeCompletion` promise |

`llm.retry` is emitted before each wait and rendered by TUI with provider, category,
delay, and attempt counts. `Retry-After` and provider-body wait hints are accepted
only at or below the configured ceiling. Backoff is abortable, and no retry starts
after the 20-minute window or when its wait would cross that window. The window does
not abort an active request; provider transports own request progress and timeout
decisions.

Moonshot `rate_limit_reached_error` uses its documented message dimension: TPD is
`hard_quota` and fails immediately, while concurrency/RPM/TPM may retry. Unknown
Moonshot 429 variants fail conservatively. If Moonshot has already delivered an SSE
chunk into the adapter buffer, the failure is marked `delivery=buffered` and is not
replayed automatically.

### 1.2 Remaining behavior (not implemented)

- The compatibility `ainvoke()` boundary still accumulates provider output before
  returning, so first-byte and stream-idle timeout events are not distinct yet.
- OpenAI/OpenRouter/xAI/Z.ai streaming adapters still need explicit buffered-delivery
  marking for terminal in-band failures; Moonshot implements that guard now.
- Compaction and max-iteration summary helper calls do not emit retry progress; the
  interactive model-step path is the implemented shared-policy boundary.
- Attempt start/end timestamps are not yet part of diagnostics.

### 1.3 Observed Moonshot TPD incident (2026-07-19)

An interactive run provided concrete evidence for this finding:

- the final response was HTTP 429 and explicitly said the organization TPD limit
  had been exceeded;
- the user waited about 86 minutes before Codelia surfaced the failure;
- Codelia labeled the hard daily limit as `transient/rate-limit`;
- no attempt number or pending wait was shown while the invocation was unresolved;
- the final TUI error contained organization, project, and API-key identifiers.

The raw identifiers are intentionally not reproduced here. The session remained
usable and could continue with another provider.

The 86-minute duration does **not** by itself prove where the time was spent. It
could include provider generation time, one or more SDK attempts, a provider
`Retry-After` delay, or transport waiting. Existing telemetry cannot separate
those phases. The implementation must record sanitized attempt start/end times,
delay source, and stream phase before this incident can be attributed more
precisely.

## 2. Ownership and dependency direction

```text
provider transport/adapter
  -> provider-specific FailureClassifier
  -> normalized ProviderFailure + delivery state + retry metadata
  -> shared Core retry coordinator
  -> safe retry lifecycle callback/event
  -> runtime transport + redacted session record
  -> TUI retry status/actionable hint
```

Responsibilities:

- Each provider adapter owns a small, pure `FailureClassifier` that extracts its
  documented error type/business code, status, safe request ID, and retry/reset
  hints. It returns a normalized failure and never sleeps, logs a raw message, or
  chooses an attempt count.
- A shared Core coordinator owns attempts, jitter/backoff, the retry window, and
  cancellation. It must not classify failures by matching a UI string. The retry
  window bounds waits and subsequent attempts, not active provider requests.
- Provider transports own first-byte and stream-idle observation because only they
  can see stream progress. They also own connect/request timeout enforcement and
  must keep activity-based timeouts independent from Core's retry window.
- Runtime redacts before display or persistence. Raw provider causes and stacks are
  available only through an explicit bounded debug path, never normal session JSONL.
- Stable retry/error events that cross Core/runtime/TUI belong in
  `packages/shared-types` and `packages/protocol`.

Parser/provider SDK error types must not escape this boundary as public policy types.

Conceptually:

```ts
type ProviderFailureContext = {
  phase: "pre_stream" | "mid_stream" | "post_stream" | "unknown";
  delivery: "none" | "buffered" | "committed";
};

interface ProviderFailureClassifier {
  classify(
    error: unknown,
    context: ProviderFailureContext,
  ): ProviderFailure;
}
```

The registry/factory may select a classifier by provider, but the provider modules
must own their parsing rules and fixtures. A single central switch containing all
vendor response shapes would couple every provider release to the same file.

The classifier precedence is:

1. documented provider error type or business code;
2. documented structured fields and retry/reset headers;
3. HTTP status plus transport phase;
4. bounded provider-specific message parsing only where the provider exposes no
   structured dimension, followed immediately by redaction;
5. a conservative non-retryable unknown failure.

For providers that mix transient and non-transient conditions under HTTP 429,
an unrecognized 429 must not enter an automatic sleep loop.

## 3. Normalized failure DTO

Planned shape:

```ts
type ProviderFailure = {
  kind:
    | "auth"
    | "permission"
    | "hard_quota"
    | "rate_limit"
    | "overloaded"
    | "timeout"
    | "network"
    | "invalid_request"
    | "content_policy"
    | "provider"
    | "cancelled";
  provider: ProviderName;
  status?: number;
  providerCode?: string;
  retryable: boolean;
  retryAfterMs?: number;
  retryHintSource?: "retry-after" | "reset-header" | "provider-body";
  nextEligibleAt?: string;
  phase: "pre_stream" | "mid_stream" | "post_stream" | "unknown";
  delivery: "none" | "buffered" | "committed";
  requestId?: string;
  safeMessage: string;
};
```

`safeMessage` must exclude API-key values/identifiers, organization/project IDs,
authorization headers, URLs containing credentials, and provider response bodies
that have not passed a bounded allowlist/redaction step.

Classification rules:

- `auth` and `hard_quota`: fail immediately; never retry automatically.
- `rate_limit`, `overloaded`, `network`, and retryable `timeout`: eligible for the
  bounded common policy.
- `permission`, `invalid_request`, and `content_policy`: fail immediately with a
  category-specific hint.
- generic `provider`: retry only when status/code is explicitly configured as safe.
- `cancelled`: terminate immediately and preserve cancellation semantics.
- Moonshot daily-token/quota errors must use structured status/provider codes when
  available instead of collapsing all 429 responses into `rate_limit`.

`hard_quota` means "not recoverable inside Codelia's short interactive retry
horizon", not necessarily permanent. A daily or weekly limit may expose a safe
`nextEligibleAt`, but the run still stops rather than sleeping until that time.

`providerCode` must come from an allowlist of stable type/code values. It must not
be populated with a free-form message. `requestId` is diagnostic metadata and must
never be confused with organization, project, account, or API-key identifiers.

## 4. Cross-provider classification summary

The automatic action below applies only before any partial model output has been
emitted. Section 6 defines the common retry limits.

| Provider | Stable signal to prefer | Transient categories | Immediate-stop categories |
| --- | --- | --- | --- |
| OpenAI | response error fields, HTTP status, `x-ratelimit-*` headers | request/token rate limit, 500, short-lived 503 overload | auth, explicit quota/credit exhaustion, invalid request |
| OpenRouter | canonical `error_type` (location depends on API skin), then status/headers | `rate_limit_exceeded`, `provider_overloaded`, `provider_unavailable`, timeout/server where documented | `payment_required`, auth/permission, validation/content-policy failures |
| Anthropic | `error.type`, status, `retry-after` | `rate_limit_error`, `overloaded_error`, retryable 5xx/504 | `billing_error`, auth/permission, invalid request |
| Moonshot | `error.type`, then the documented limit dimension in the message | `engine_overloaded_error`; concurrency/RPM/TPM `rate_limit_reached_error`; 500/503 | `exceeded_current_quota_error`; TPD `rate_limit_reached_error`; auth/permission |
| xAI | HTTP status and SDK error type | 429 RPS/TPM rate limit; documented retryable server/network failures | auth/permission, validation; unknown account/quota messages until structured evidence exists |
| Z.ai | inner business `error.code` before outer HTTP status | 1302 rate limit, 1305 overload, 1234 network error | 1113 balance; 1308-1321 usage/subscription/policy cases as mapped below; auth/validation |

This table is a policy summary, not a substitute for adapter tests using the exact
provider response shapes.

## 5. Provider-specific evidence and mapping

### 5.1 OpenAI

Official behavior:

- OpenAI distinguishes a 429 caused by sending requests too quickly from a 429
  caused by exhausted credits or a monthly spend limit.
- Rate limits can be RPM, RPD, TPM, TPD, and other model-specific dimensions;
  organization and project limits can both apply.
- `x-ratelimit-limit-*`, `x-ratelimit-remaining-*`, and
  `x-ratelimit-reset-*` headers describe the constrained request/token dimension.
- The official SDK retries connection errors, 408, 409, 429, and 5xx twice by
  default. Its request timeout is ten minutes by default.

Codelia mapping:

- explicit quota/credit exhaustion -> `hard_quota`, no automatic retry;
- ordinary request/token 429 -> `rate_limit`; use the reset for the exhausted
  dimension as a bounded hint when available;
- 500 -> retryable `provider`; 503 overload -> `overloaded`;
- a 503 "slow down" response that asks for sustained traffic reduction is not a
  reason to keep an interactive run sleeping for many minutes; stop when the
  common delay/deadline ceiling would be exceeded.

Sources: [OpenAI error codes](https://developers.openai.com/api/docs/guides/error-codes),
[OpenAI rate limits](https://developers.openai.com/api/docs/guides/rate-limits), and
[official openai-node retry/timeout behavior](https://github.com/openai/openai-node#retries).

### 5.2 OpenRouter

Official behavior:

- `error_type` is the stable cross-API-skin classifier; native OpenAI/Anthropic
  fields can collapse multiple categories.
- `rate_limit_exceeded`, `provider_overloaded`, and `provider_unavailable` are
  distinct. Insufficient credits use `payment_required` / HTTP 402.
- HTTP 429 and 503 may carry `Retry-After`; it is not guaranteed.
- a pre-stream failure can be rerouted, but after partial content a failure arrives
  in-band over SSE with HTTP 200 and cannot be silently failed over.

Codelia mapping:

- read the documented `error_type` location for the selected Chat Completions,
  Responses, or Anthropic skin before consulting native codes;
- `payment_required` -> `hard_quota`;
- `rate_limit_exceeded` -> `rate_limit`; `provider_overloaded` -> `overloaded`;
- `provider_unavailable`, `timeout`, and `server` are retryable only pre-stream;
- any mid-stream error terminates the attempt without replay after partial output.

Sources: [OpenRouter errors and typed error codes](https://openrouter.ai/docs/api_reference/errors-and-debugging)
and [OpenRouter credit/rate limits](https://openrouter.ai/docs/api_reference/limits).

### 5.3 Anthropic

Official behavior:

- 429 is `rate_limit_error`; RPM, input-token, output-token, and acceleration
  limits can apply. A `retry-after` header gives seconds to wait and an earlier
  retry will fail.
- 402 is `billing_error`, 529 is `overloaded_error`, 500 is `api_error`, and 504
  is `timeout_error`.
- official SDKs retry connection errors, rate limits, and 5xx twice by default,
  honoring `retry-after` when present.
- SSE can report an error after HTTP 200, so HTTP status alone is insufficient.

Codelia mapping:

- `billing_error` -> `hard_quota`; `rate_limit_error` -> `rate_limit`;
- `overloaded_error` -> `overloaded`;
- `api_error` and `timeout_error` are bounded transient failures before output;
- an SSE error after partial output is terminal for the current invocation.

Sources: [Claude API errors](https://platform.claude.com/docs/en/api/errors) and
[Claude rate limits](https://platform.claude.com/docs/en/api/rate-limits).

### 5.4 Moonshot / Kimi

Official behavior:

- user-level limits are shared across all models and include concurrency, RPM,
  TPM, and TPD. The gateway accounts request tokens plus
  `max_completion_tokens`, not the actual completion size, for rate limiting.
- 429 `engine_overloaded_error` is temporary capacity pressure.
- 429 `exceeded_current_quota_error` means insufficient balance, disabled account,
  or insufficient token quota.
- 429 `rate_limit_reached_error` is reused for concurrency, RPM, TPM, and TPD.
  Concurrency/RPM messages provide a wait; TPD resets the next day.
- the service documents a two-hour request timeout and 504 after that limit.

Codelia mapping:

- `engine_overloaded_error` -> `overloaded`;
- `exceeded_current_quota_error` -> `hard_quota`;
- concurrency/RPM/TPM `rate_limit_reached_error` -> `rate_limit` with a bounded
  parsed wait hint when present;
- TPD `rate_limit_reached_error` -> `hard_quota`, even though Moonshot calls it a
  rate limit. This is an explicit Codelia policy because a next-day recovery is
  outside an interactive retry horizon;
- 500/503 -> bounded transient provider failure; 499 caused by user cancellation
  must remain `cancelled` rather than become a retry;
- switching to another Moonshot model does not escape the shared user-level TPD
  pool; the final hint should suggest waiting for reset or changing provider.

Because the documented TPD distinction is embedded in a free-form message rather
than a unique `error.type`, the Moonshot adapter needs a focused, tested parser.
It must extract only the dimension/wait and redact the message before returning a
failure. The provider's two-hour timeout is not an acceptable Codelia overall
deadline by itself.

Sources: [Kimi common errors](https://platform.kimi.ai/docs/api/errors),
[Kimi rate-limit concepts](https://platform.kimi.ai/docs/introduction), and
[Kimi account tiers and limit dimensions](https://platform.kimi.ai/docs/pricing/limits).

### 5.5 xAI

Official behavior:

- each team has hard per-model RPS and TPM caps; any exceeded dimension returns
  HTTP 429;
- all prompt, completion, reasoning, and cached prompt tokens count toward TPM;
- the official guidance is exponential backoff. The current documentation does
  not promise a `Retry-After` header.

Codelia mapping:

- documented inference 429 -> `rate_limit`;
- use the common jittered backoff when no documented retry hint exists;
- do not infer whether RPS or TPM was hit unless a structured response says so;
- preserve auth, permission, validation, and generic server failures as separate
  categories rather than converting every OpenAI-compatible SDK exception to 429.

Sources: [xAI rate limits](https://docs.x.ai/developers/rate-limits) and
[xAI error debugging](https://docs.x.ai/developers/debugging).

### 5.6 Z.ai

Official behavior:

- the outer HTTP status and inner `error.code` are separate; the business code is
  the more precise classifier;
- the following materially different cases all use HTTP 429:

| Z.ai business code | Meaning | Codelia mapping/action |
| --- | --- | --- |
| 1113 | insufficient balance/resource package | `hard_quota`; stop |
| 1302 | request rate limit | `rate_limit`; bounded retry |
| 1305 | temporary overload | `overloaded`; bounded retry |
| 1308 | usage limit with reset time | `hard_quota`; expose safe reset time, stop |
| 1309-1310 | expired package or weekly/monthly exhaustion | `hard_quota`; stop |
| 1311 | plan lacks model access | `permission`; stop |
| 1313 | fair-usage restriction requiring review | `permission`; stop |
| 1314-1315 | expired enterprise package or wrong key product | `permission` or `hard_quota`; stop |
| 1316-1321 | multi-hour/weekly limit plus unavailable extra usage/spend cap | `hard_quota`; expose safe reset time, stop |
| 1234 | network error, try later | `network`; bounded retry |

`hard_quota` is deliberate for resettable Z.ai windows because Codelia must not
silently sleep for hours or days. The UI can display a validated `nextEligibleAt`.
The current documentation does not promise `Retry-After`, so 1302/1305 use common
backoff unless a future documented header is present.

For streaming calls, Z.ai says an abnormal termination may omit the normal error
code and report only `finish_reason`. The adapter must classify that terminal event
and must not replay after partial output.

Source: [Z.ai error/business codes](https://docs.z.ai/api-reference/api-code).

### 5.7 Documented gaps and conservative defaults

- OpenAI documents reset headers but does not promise `Retry-After` for every 429.
- OpenRouter says `Retry-After` may be present, not that it always is.
- xAI and Z.ai do not currently document a general `Retry-After` contract.
- Moonshot documents wait text for short limits and next-day TPD recovery, but no
  distinct TPD error type. Message parsing is therefore unavoidable until the
  provider adds a structured dimension.
- A retry hint is provider input, not a command. Codelia validates it, caps it, and
  includes it when deciding whether another attempt fits within the retry window.
- Unknown error types/codes must remain visible as a safe generic failure and must
  not be guessed into a retryable class.

## 6. Transport mode and delivery commit boundary

The target is **stream-first, not stream-only**.

- Interactive model generation should use a streaming transport where the provider
  supports it, so Codelia can observe first byte, idle periods, cancellation, usage,
  and terminal in-band errors.
- Core should expose an internal async event stream (`started`, `delta`, `usage`,
  `completed`, `failed`) rather than making each adapter accumulate through an
  opaque promise.
- A compatibility `ainvoke()` can collect those events into one
  `ChatInvokeCompletion` for callers that intentionally need an atomic result.
- A provider/non-streaming endpoint can participate by producing `started` followed
  by one `completed` or `failed` event. It does not need a separate retry system.
- Small structured/internal calls may remain non-streaming when atomic completion is
  simpler. They must still apply caller cancellation and a provider-owned request or
  first-response timeout; the common retry window must not abort an active call.

Changing all calls to streaming is therefore not a prerequisite for normalized
errors. The classifier/coordinator boundary should land first or together with the
internal event interface; converting Anthropic to streaming can follow without
changing retry semantics.

Retry safety depends on delivery state, not only HTTP mode:

| State | Default retry decision | Reason |
| --- | --- | --- |
| failure before response/first event (`delivery=none`) | eligible when normalized failure is retryable | no model output has been exposed |
| partial provider stream buffered only inside adapter (`delivery=buffered`) | conservative stop initially; later allow only with explicit cost/idempotence policy | replay may duplicate provider work/cost even though UI has not seen it |
| any output/event committed to runtime/TUI/session (`delivery=committed`) | never replay automatically | replay would duplicate or contradict visible history |
| atomic non-stream response completed | no retry needed | result is already complete |

Hosted provider tools and future side-effecting generation features may make an
attempt non-replayable even before text is committed. The attempt event must be able
to mark that condition; `delivery=none` alone is not proof of idempotence.

## 7. Retry policy

Implemented requirements for interactive model steps:

1. Count total attempts explicitly and expose them to observers.
2. Use exponential backoff with jitter and a finite maximum delay.
3. Honor `Retry-After` only within a finite configured ceiling. A value above the
   ceiling ends automatic retry with an actionable safe error instead of silently
   sleeping for the provider-supplied duration.
4. Make backoff abortable; `run.cancel` must stop a pending wait promptly.
5. Start one 20-minute retry window with the first attempt. Do not start another
   attempt after it elapses, and do not begin a backoff that would cross it.
6. Do not use the retry window as an active-request deadline. Pass caller
   cancellation to the provider operation; provider transports own connect,
   request/first-byte, and stream-idle timeouts. Separate first-byte and stream-idle
   classification remains part of the stream-first follow-up.
7. Use the delivery/replayability state from section 6. Never automatically replay
   after model output has been externally emitted or persisted.
8. Do not retry auth, payment, hard quota, schema/validation, or unsupported-model
   failures.

The defaults are 3 total attempts, 1-second base backoff, 60-second backoff and
provider-wait ceilings, and a 20-minute retry window. `AgentOptions` can override
those values with finite settings; an invalid value falls back to the documented
default.

## 8. Retry visibility

Core emits a structured, safe lifecycle event before each wait:

```ts
type LlmRetryEvent = {
  type: "llm.retry";
  provider: ProviderName;
  failure_kind: "rate_limit" | "overloaded" | "timeout" | "network" | "provider";
  next_attempt: number;
  max_attempts: number;
  delay_ms: number;
  delay_source: "retry-after" | "reset-header" | "provider-body" | "backoff";
  status?: number;
};
```

The TUI renders a compact status such as
`LLM retry: moonshot rate_limit in 12s (2/3)`. Final safe messages distinguish:

- hard quota: stop waiting; review quota/billing or change provider/model;
- rate limit/overload: retry later or let bounded retry continue;
- auth: check credentials;
- timeout/network: retry or check connectivity.

The event and session record must not contain raw provider messages or stacks.

## 9. Error display and persistence

Before `run.status(error)` or `run.error` is sent/persisted, runtime now:

1. Normalize the error into `ProviderFailure` when it originated from an LLM call.
2. Generate a bounded `safeMessage` for UI and session history.
3. Persist structured safe fields (`kind`, provider, status, attempt counts, optional
   redacted request ID) rather than the raw SDK stack.
4. Keep raw diagnostic material opt-in, local, bounded, and covered by secret tests.

Cancellation remains `cancelled`, not a provider failure.

## 10. Implementation sequence

1. **Implemented:** add provider-failure classification and redaction tests using
   synthetic errors.
2. **Partial:** add the internal attempt-event and delivery/replayability boundary while keeping
   `ainvoke()` as an accumulating compatibility wrapper.
   Moonshot detects buffered partial delivery; the other streaming adapters remain.
3. **Implemented:** add the abortable retry coordinator with injected
   clock/sleep/randomness.
4. **Implemented for Codelia-constructed clients:** set OpenAI/Anthropic SDK clients
   to `maxRetries: 0` after the coordinator
   covers their current retryable cases.
5. **Implemented:** route Z.ai through the same coordinator.
6. **Remaining:** convert Anthropic interactive generation to the internal stream and add
   first-byte/stream-idle watchdogs at every streaming transport boundary.
7. **Implemented:** add `llm.retry` to shared types/protocol and render it in TUI.
8. **Implemented for classified LLM failures:** replace raw runtime error persistence
   with safe structured failure records.

Do not change one provider in isolation and leave a second hidden retry loop active.

## 11. Acceptance scenarios

- 429 with a short valid `Retry-After` performs bounded retry and emits attempt/wait
  progress.
- 429 hard quota fails immediately without sleeping.
- Moonshot TPD and Z.ai long-window quota errors fail immediately and expose only
  a safe reset hint; ordinary short rate limits remain retryable.
- 529 and 503 normalize to overload/transient failure and follow the bounded policy.
- Excessive `Retry-After` does not cause an unbounded wait.
- `run.cancel` during backoff aborts promptly and finishes as cancelled.
- provider request/first-byte timeout, stream-idle timeout, and retry-window expiry
  are distinguishable.
- the same provider classifier handles both HTTP exceptions and in-band terminal
  stream errors without a second retry loop.
- an uncommitted pre-stream failure can retry, while a committed partial response
  cannot replay automatically.
- no provider API-key/org/project identifiers or raw stack appear in TUI events or
  session JSONL.
- SDK-level retries are disabled after the common coordinator is active, preventing
  multiplicative retries.
- attempt timestamps and delay source make a future long-wait incident attributable
  without persisting the raw provider message.
