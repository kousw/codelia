# models

Location for model definitions and registries. Solve and list using `registry.ts`.

## Model definition

Visit each provider's site to define supported models.

The model list is a snapshot, so check the update date and review it regularly.

- Use `supportsFast: true` only for model ids that support the provider-specific fast path. Runtime maps that flag per provider (for example OpenAI priority service tier, Anthropic fast mode) and leaves unsupported models disabled even when `model.fast` is configured.
- Set `supportsVision: true` for verified image-input models supported by the provider adapter. Copied-image admission uses the effective registry, so a static flag allows attachments when external metadata lacks the modality. Verify snapshots by their exact provider IDs. Leave unverified capabilities unset.
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
- Anthropic fast mode is supported on Fable 5.2, Opus 5.5, Opus 5, and Opus 4.8. Opus 4.7 rejects fast requests; Opus 4.6 silently runs them at standard speed. Fable 5.1 and Sonnet 5 have no fast mode flag.
- Fable 5.2 has 1M context/128K output and native five-level adaptive thinking; forced tool choice and sampling parameters are rejected locally. Preserve its prefix-bound signed thinking. [Model contract](https://platform.claude.com/docs/en/models/fable-5-2/overview), checked 2026-11-13; live access is unverified.
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

## DeepSeek models

- Only `deepseek-flash` (rolling alias currently serving V4.1-Flash-1017) and `deepseek-v4-pro` are registered. Do not invent a pinned Flash version ID. Static context/output budgets are conservative decimal 1M/384K; Flash alone supports vision. Native low/high/max effort maps medium/xhigh to high. Neither supports Fast. See the DeepSeek provider spec, checked 2026-11-02.

## Google Gemini 4

- `gemini-4-carbon`, `gemini-4-hydrogen`, and `gemini-4-argon` share a 1,048,576-token input/thinking/output context. Static input is 983,040 to reserve the 65,536 synchronous output budget; do not advertise long decode as supported by the stateless adapter.
- Hydrogen supports native `low|medium|high|xhigh` (default `high`); Carbon/Argon support `low|medium|high` (default `medium`). Hydrogen is the default Google chat model.
- Checked [Carbon](https://aistudio.google.com/docs/models/gemini-4-carbon) and [Hydrogen](https://aistudio.google.com/docs/whats-new-gemini-4-hydrogen) on 2026-11-13; both have SDK request fixtures. Hydrogen also passed live chat/tool smoke on 2026-11-22.

## GPT-6.2 Astra and Sol

- The existing OpenAI Responses adapter serves `gpt-6.2-astra` and `gpt-6.2-sol`.
- Both use the 270K Codelia normal input cap, 1.05M context, 128K output, and native `low|medium|high|xhigh|max` reasoning. OpenAI applies long-context pricing above 272K input.
- Both are selectable with Fast and Ultrafast through the existing runtime
  settings. OpenAI determines eligibility on both the API and Codex OAuth
  routes. Live Ultrafast requests remain unverified.
- Sources (2026-11-18) [Astra](https://developers.openai.com/api/docs/models/gpt-6.2-astra), [Sol](https://developers.openai.com/api/docs/models/gpt-6.2-sol).
