# Anthropic / Claude provider

Status: Implemented for the native Messages adapter, Sonnet/Haiku 5.5 and Fable 5.2.
Fable 5.2 checked: 2026-11-13. Live account access and paid model calls are unverified.

## Model selection and request contract

- `claude-sonnet-5-5` and `claude-haiku-5-5` are selectable static entries:
  1,000,000 context/input and 128,000 maximum output tokens.
- Both use adaptive thinking and native `low|medium|high|xhigh|max` effort.
  Codelia keeps its existing medium reasoning default and Sonnet 4.5 provider
  default. Neither new entry enables Fast or Ultrafast.
- The adapter defaults adaptive thinking to `display: summarized` so progress
  carried in thinking blocks remains visible. An explicit display setting wins.
- Legacy thinking budgets, sampling parameters, Fast, and assistant prefill are
  rejected locally with safe provider validation failures for these two models.
  Sonnet also rejects disabled thinking and required/named tool choice; Haiku
  retains disabled thinking and forced tool selection. Unsupported selection
  never silently becomes auto or another model.
- Normal requests retain official-SDK streaming, terminal-message restoration,
  cancellation, prompt caching and the common refusal/failure handling.
- `claude-fable-5-2` has the same 1M context/input, 128K output and five native
  adaptive effort levels, plus Claude API Fast mode. Its API default effort is
  high; Codelia's existing runtime default remains medium. Reject legacy or
  disabled thinking, forced tool choice, sampling parameters and prefill locally.
  It defaults to summarized thinking and uses the same prefix-bound replay.
  Anthropic requires 30-day retention and does not allow zero data retention
  unless Anthropic expressly authorizes it;
  API/account availability and Fast execution remain unverified by live calls.

## Thinking replay for Sonnet/Haiku 5.5 and Fable 5.2

`packages/core/src/llm/anthropic/thinking.ts` owns conservative prefix checking.

- Preserve signed thinking (including empty text), redacted thinking, text
  metadata/citations and tool blocks in their original order. Contiguous
  canonical assistant/reasoning items become one Messages assistant turn.
  Hosted search use/result blocks also retain their native block shapes.
- Store a local SHA-256 prefix fingerprint alongside each raw thinking block;
  it covers serialized system, tools, message roles and all preceding blocks.
  Sorted object keys tolerate JSON persistence without treating reordered keys
  as edits. Local fingerprints are removed before transport.
- Reuse only blocks whose fingerprint matches the current serialized prefix.
  System/tool changes, shortened tool output, edited content, orphan cleanup,
  compaction or missing earlier thinking invalidate affected later reasoning.
  Invalid or legacy unbound thinking is omitted from that request; text and
  tool history remain available, and newly generated thinking can be reused.
- Fingerprints live in durable history, so resume needs no adapter process state.
  Outbound filtering does not rewrite stored response content or signatures.
  The server still owns account/model readability and signature validation.
- This is scoped to these three models. Older-model serialization keeps its
  existing behavior. It does not enable server `drop_block`, automatic request
  replay, cross-account rebinding or a model fallback.
- Fable 5.2 thinking is readable by Fable/Mythos 5.2, but Anthropic says older
  models drop those blocks on receipt. Switching models does not imply the
  previous model can use Fable 5.2's reasoning; server behavior is unverified.

## Verification

Mocked SDK streams and runtime-factory requests cover these model IDs, native
adaptive efforts, caps, exact signed tool-turn replay after JSON resume, prefix
edits and fresh reasoning recovery, safe local admission failures, Fable Fast
and Haiku forced tools. Existing serializer/refusal/cancellation coverage remains active.
No live API acceptance or quality/cost evaluation is implied.

## Primary sources

- [Fable 5.2 overview](https://platform.claude.com/docs/en/models/fable-5-2/overview)
- [Fable 5.2 changes](https://platform.claude.com/docs/en/models/fable-5-2/whats-new-fable-5-2)
- [Sonnet 5.5 overview](https://platform.claude.com/docs/en/models/sonnet-5-5/overview)
- [Sonnet migration](https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide)
- [Haiku 5.5 overview](https://platform.claude.com/docs/en/models/haiku-5-5/overview)
- [Haiku migration](https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide)
- [Preserved thinking](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking)
