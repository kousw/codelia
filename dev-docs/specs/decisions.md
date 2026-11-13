# Decisions tool

Status: **Implemented**, with live provider access unverified.

The TUI-local runtime exposes a model-callable `decision` tool independently of
the chat model and image-generation configuration. The caller explicitly chooses
OpenAI (`gpt-6-luna`, `https://api.openai.com/v1/decisions`) or Google
(`gemini-decision-1`, `https://generativelanguage.googleapis.com/v1beta/decisions`).
The chosen provider requires a saved API key or its normal environment key;
OpenAI chat OAuth is not used. There is no implicit endpoint, model, provider,
or auth fallback. Embedded non-TUI hosts do not acquire this local tool or its
filesystem/auth services implicitly.

## Request and result

The common contract accepts nonblank shared text and/or 1–4 explicitly selected
PNG/JPEG/WebP image references (local runtime file, public URL, or saved image
artifact). Image originals are read only after authorization and sent inline;
the combined byte limit is 16 MiB. The existing image source reader enforces
file sandboxing, URL destination/port/proxy rules, no redirects, header and
dimension validation, and per-source bounds. Text is limited to 100,000
characters. A request contains 1–32 uniquely named, independent questions:

- `predicate`: probability that the statement is true;
- `choice`: 2–20 uniquely named options, with optional descriptions;
- `score`: 2–10 ordered unique levels, with optional descriptions.

IDs are ASCII letters, digits, `_`, and `-`, at most 64 characters. Each
question instruction is 1–4,000 characters. The provider request maps
predicates to Google `noul` or OpenAI `predicate`, choice options to Google's
criteria map or OpenAI's choices array, and score levels to Google's criteria
array or OpenAI's levels array. Google combines each score label and optional
description as a criterion. Google sorts choice IDs by UTF-8 order for tie
breaking; tool results retain the caller's option order.

Results identify the provider and requested model, include the reported model
only when provided, and return named answers in input order. Predicate
probability is P(true). Choice and score distributions retain the provider's
values; score is the probability-weighted, zero-based level index. Confidence
is retained when returned and is not inferred for OpenAI predicates. OpenAI's
per-question refusals are preserved. Missing, duplicate, unknown, malformed,
or mismatched answers and distributions fail the entire request. Available
provider token counts are normalized and returned in the tool result, but are
not included in chat usage or cost aggregation.

## Permissions and transport

Permission evaluation occurs inside the tool, including direct `tool.call`
RPC, before credentials or images are read. The existing approval mode, allow
and deny rules control whether confirmation is required. The prompt identifies
the chosen provider/model, text preview, explicit image references, and
questions; URL query parameters are omitted from that display. The full
selected evidence goes to the chosen API and is subject to that provider's
billing and data policy.

Requests use fixed HTTPS origins, forbid redirects, have a 30-second timeout,
honor cancellation, and never retry automatically. Responses are capped at
2 MiB. Provider error bodies and credentials are not returned in errors. A
cancelled, timed-out, or failed submitted request might still have been billed.
No API availability probe occurs at startup; an unavailable key or model is
reported when requested.

## Scope and evidence

Shared text and images plus predicate/choice/score are implemented. PDF,
audio, video, per-question images, provider-specific knobs, and native chat
usage accounting are not implemented. Google uses direct REST because the
workspace's installed `@google/genai` version predates Decisions support.
Provider wire fixtures and local permission/RPC tests cover both schemas and
image inputs. Real Decision API access and billing have not been tested.

Provider references: [OpenAI Decisions](https://developers.openai.com/api/docs/guides/decisions),
[OpenAI Decisions API](https://developers.openai.com/api/reference/resources/decisions/methods/create),
and [Google Decisions](https://aistudio.google.com/docs/decisions-api).
