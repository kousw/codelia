# models

Location for model definitions and registries. Solve and list using `registry.ts`.

## Model definition

Visit each provider's site to define supported models.

The model list is a snapshot, so check the update date and review it regularly.

- Use `supportsFast: true` only for model ids that support the provider-specific fast path. Runtime maps that flag per provider (for example OpenAI priority service tier, Anthropic fast mode) and leaves unsupported models disabled even when `model.fast` is configured.
- A model is usable only when the effective spec has a positive context budget (`maxInputTokens` or `contextWindow`). If metadata can be missing for a new/latest model that should still work, put the required limits in the static `ModelSpec`.

## Z.ai models

- Z.ai static models are ordered newest/highest-priority first so `model.list`
  presents newer GLM variants above older ones.
- `glm-5.2` is available in the static Z.ai registry with 1M context and 131,072 max output tokens.
- `glm-5.1`, `glm-5`, `glm-5-turbo`, and `glm-4.7` are available in the static Z.ai registry with 200K context and 131,072 max output tokens.
- `glm-5.3` and `glm-5.2` receive `reasoning_effort`; older Z.ai models keep `thinking` enabled but use provider defaults for effort. GLM-5.3 supports low/high/max; preserve the older 5.2 mapping.
- Keep Z.ai phase 1 model listing static unless a stable provider model-list endpoint and response shape are confirmed.

## xAI models

- `grok-4.5` is the default xAI model with a published 500K context window and text/image input.
- Keep normal `maxInputTokens` at 200K because xAI applies higher-context pricing above 200K.
- Provider aliases `grok-4.5-latest` and `grok-build-latest` resolve to the same static model; do not add a synthetic `default` alias.
- xAI exposes `/v1/language-models`, but model listing remains static until per-model reasoning/tool capabilities are represented safely.

## Anthropic reasoning effort

- `claude-fable-5-1`, `claude-opus-5-5`, and `claude-sonnet-5` have 1M context, 128k max output, and native `low|medium|high|xhigh|max` effort. Fable 5.1 and Opus 5.5 require adaptive thinking; Sonnet 5 uses adaptive thinking in Codelia.
- Anthropic fast mode is supported on Opus 5.5, Opus 5, and Opus 4.8 only. Opus 4.7 rejects fast requests; Opus 4.6 silently runs them at standard speed. Fable 5.1 and Sonnet 5 have no fast mode flag.
- Sources: [model lineup](https://platform.claude.com/docs/en/models/overview), [effort](https://platform.claude.com/docs/en/build-with-claude/effort), [fast mode](https://platform.claude.com/docs/en/build-with-claude/fast-mode), checked 2026-09-23.
- `claude-fable-5` is generally available with 1M context, 128k max output tokens, always-on adaptive thinking, and native `low|medium|high|xhigh|max` effort.
- Fable classifier refusals arrive as successful responses with `stop_reason=refusal`; discard partial content and surface the human-readable refusal explanation.
- `claude-opus-4-8` is available in the static Anthropic registry with 1M context, 128k max output tokens, and Anthropic fast mode support.
- `claude-opus-4-7` is available in the static Anthropic registry with 1M context and 128k max output tokens.
- Anthropic Opus 4.8 and 4.7 use adaptive thinking and keep provider-native `xhigh` and `max` as distinct `output_config.effort` values.
- Anthropic Opus 4.6 and Sonnet 4.6 use adaptive thinking and support `max`, but not provider-native `xhigh`; Codelia falls `xhigh` back to `high` for those models.
- Do not route adaptive-thinking models through legacy extended thinking budget requests.

## OpenAI GPT-5.5

- `gpt-5.5` remains available as the previous OpenAI default model.
- OpenAI's April 2026 GPT-5.5 release note describes API context as 1M and Codex app context as 400K; models.dev currently carries the precise API limits as `context: 1_050_000`, `input: 920_000`, and `output: 130_000`.
- Follow the `gpt-5.4` pattern: keep plain `gpt-5.5` capped for normal use (`maxInputTokens: 270_000`) and expose full API context through synthetic `gpt-5.5-1M` / `gpt-5.5-full` aliases that send provider model `gpt-5.5`.

## OpenAI GPT-6.1 Terra

- `gpt-6.1-terra` uses the same 1,050,000 context, 270,000 normal input cap, 128,000 output limit, and Fast support. Its API also supports `none`, which is not exposed by Codelia's current reasoning levels; `low|medium|high|xhigh|max` are available. Ultrafast is not supported.
- Source: [Terra model](https://developers.openai.com/api/docs/models/gpt-6.1-terra), checked 2026-10-27. Live API/OAuth access has not been verified.

## OpenAI GPT-6.1 Sol

- `gpt-6.1-sol` is selectable through the existing Responses API adapter with native `low|medium|high|xhigh|max` reasoning; `none` and `minimal` are unsupported.
- Published context/input/output limits are 1,050,000/922,000/128,000 tokens. Keep normal input capped at 270,000 to stay below the 272K long-context pricing threshold.
- Fast mode maps to OpenAI priority service tier and is unavailable with EU data residency. The OpenAI default remains `gpt-5.6`.
- Source: [model](https://developers.openai.com/api/docs/models/gpt-6.1-sol), checked 2026-09-30. Live API/OAuth access has not been verified.

## OpenAI GPT-6 Astra

- `gpt-6-astra` is selectable through the existing Responses API adapter with native `low|medium|high|xhigh|max` reasoning. The default remains `gpt-5.6`.
- Published context/output limits are 1,050,000/128,000 tokens; normal input is capped at 270,000 to stay below the 272K long-context pricing threshold. No synthetic aliases are registered.
- Fast mode is supported, but unavailable with EU data residency; use standard processing there.
- Sources: [model](https://developers.openai.com/api/docs/models/gpt-6-astra), [migration guide](https://developers.openai.com/api/docs/guides/latest-model), checked 2026-09-06. Async tools and mid-turn steering are separate from this model registration.

## OpenAI GPT-6 Sol and Luna

- `gpt-6-sol` and `gpt-6-luna` use the existing Responses API adapter with `low|medium|high|xhigh|max` reasoning and OpenAI priority service tier when fast mode is selected.
- Both publish 1,050,000 context and 128,000 max output tokens. Keep normal input capped at 270,000 to avoid crossing the 272K long-context pricing threshold. The OpenAI default remains `gpt-5.6`.
- Sources: [Sol](https://developers.openai.com/api/docs/models/gpt-6-sol), [Luna](https://developers.openai.com/api/docs/models/gpt-6-luna), checked 2026-09-23.

## OpenAI GPT-5.6 family

- `gpt-5.6` (the provider alias for Sol), `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna` are available in the static OpenAI registry.
- OpenAI publishes a 1,050,000-token context window, 922,000 max input tokens, and 128,000 max output tokens for all four provider ids. Requests above 272K input tokens enter the long-context pricing tier.
- The four provider ids use `maxInputTokens: 270_000` for cost safety. Do not add synthetic `-1M` / `-full` entries or a `default` alias for GPT-5.6; `OPENAI_DEFAULT_MODEL` controls the default selection directly.
- `gpt-5.6` is the default OpenAI model via `OPENAI_DEFAULT_MODEL`; the provider alias routes to Sol.
- GPT-5.6 family models accept provider-native `max` reasoning above `xhigh`; older OpenAI models fall back to their nearest supported effort.

## OpenAI GPT-5.4 variants

- `gpt-5.4-mini` / `gpt-5.4-nano` are listed in official OpenAI model docs with 400K context and 128K max output tokens; models.dev currently reports `input: 272_000` for both.
- `gpt-5.4-pro` is listed as a current GPT-5.4 family model; models.dev currently reports `context: 1_050_000`, `input: 922_000`, and `output: 128_000`.
- Keep these variants as selectable registry entries only; do not change `OPENAI_DEFAULT_MODEL` again unless explicitly requested.

- Named endpoint specs use qualified `endpoint/model` IDs plus raw-model aliases in provider-specific buckets. Preserve dynamic alias buckets when cloning registries and never resolve a direct ID from a different requested provider.

## October 2026 additions

- `grok-4.7` retains 500K context / conservative 200K input, supports native xhigh,
  and leaves Grok 4.5/default/aliases unchanged. Public API Fast is unavailable.
- `kimi-k3.1-pro` / `kimi-k3.1-pro-highspeed` retain K3's 1,048,576 context/input/
  max-output limits with native low/high/max; the default remains K3 (max-only).
- `glm-5.3` has conservative 1M context/input and 131,072 max output; text-only.
- Checked official provider docs 2026-10-24; live account access is unverified.

- Sonnet/Haiku 5.5 use native adaptive five-level effort, 1M context/input and 128K output; neither has Fast. See `dev-docs/specs/providers/anthropic-provider.md` for replay and request restrictions (checked 2026-10-25).
