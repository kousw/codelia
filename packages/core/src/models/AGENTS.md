# models

Location for model definitions and registries. Solve and list using `registry.ts`.

## Model definition

Visit each provider's site to define supported models.

The model list is a snapshot, so check the update date and review it regularly.

- Use `supportsFast: true` only for model ids that support the provider-specific fast path. Runtime maps that flag per provider (for example OpenAI priority service tier, Anthropic fast mode) and leaves unsupported models disabled even when `model.fast` is configured.

## Anthropic Claude Opus 4.7

- `claude-opus-4-7` is available in the static Anthropic registry with 1M context and 128k max output tokens.
- Anthropic Opus 4.7 uses adaptive thinking plus `output_config.effort`; do not route it through legacy extended thinking budget requests.

## OpenAI GPT-5.5

- `gpt-5.5` is available in the static OpenAI registry, but it is not the default model unless `OPENAI_DEFAULT_MODEL` is intentionally changed.
- OpenAI's April 2026 GPT-5.5 release note describes API context as 1M and Codex app context as 400K; models.dev currently carries the precise API limits as `context: 1_050_000`, `input: 920_000`, and `output: 130_000`.
- Follow the `gpt-5.4` pattern: keep plain `gpt-5.5` capped for normal use (`maxInputTokens: 270_000`) and expose full API context through synthetic `gpt-5.5-1M` / `gpt-5.5-full` aliases that send provider model `gpt-5.5`.
