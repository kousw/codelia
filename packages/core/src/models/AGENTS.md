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
- Only `glm-5.2` receives `reasoning_effort`; older Z.ai models keep `thinking` enabled but use provider defaults for effort.
- Keep Z.ai phase 1 model listing static unless a stable provider model-list endpoint and response shape are confirmed.

## Anthropic reasoning effort

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

## OpenAI GPT-5.6 family

- `gpt-5.6` (the provider alias for Sol), `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna` are available in the static OpenAI registry.
- All four ids have a 1,050,000-token context window, 922,000 max input tokens, 128,000 max output tokens, and OpenAI priority-processing support.
- `gpt-5.6` is the default OpenAI model via `OPENAI_DEFAULT_MODEL`; the provider alias routes to Sol.
- GPT-5.6 family models accept provider-native `max` reasoning above `xhigh`; older OpenAI models fall back to their nearest supported effort.

## OpenAI GPT-5.4 variants

- `gpt-5.4-mini` / `gpt-5.4-nano` are listed in official OpenAI model docs with 400K context and 128K max output tokens; models.dev currently reports `input: 272_000` for both.
- `gpt-5.4-pro` is listed as a current GPT-5.4 family model; models.dev currently reports `context: 1_050_000`, `input: 922_000`, and `output: 128_000`.
- Keep these variants as selectable registry entries only; do not change `OPENAI_DEFAULT_MODEL` again unless explicitly requested.
