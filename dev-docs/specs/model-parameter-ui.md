# Model Reasoning Mapping Spec

## 1. Goal

- Keep one user-facing reasoning control: `model.reasoning`.
- Absorb provider/model differences in runtime mapping.
- Keep UI simple while allowing provider-native tuning internally.

## 2. User-facing contract

- `model.reasoning` is the only reasoning knob.
- Allowed values: `low | medium | high | xhigh`.
- No reasoning off toggle in this phase.
- No user-facing `thinking.budget_tokens` field.
- No user-facing per-model parameter map for reasoning.

## 3. Runtime mapping

### 3.1 Common flow

1. Read `model.provider`, `model.name`, `model.reasoning`.
2. Validate reasoning value (`low|medium|high|xhigh`).
3. Resolve provider/model capability.
4. Apply provider-specific mapping.
5. If unsupported, fallback to nearest-lower supported level.
6. Emit both `requested` and `applied` levels in diagnostics metadata.

### 3.2 OpenAI and OpenRouter

- Map canonical level directly to `request.reasoning.effort`.
- Capability-gate `xhigh` by model and fallback when unsupported.

### 3.3 Anthropic model-specific mapping

Anthropic is handled by a model capability table keyed by model id.

Each entry must define:

- `supportedLevels`: subset of `low|medium|high|xhigh`
- `budgetPresetByLevel`: mapping from level to an internal preset id
- optional model-specific overrides

Runtime then maps preset id to provider request fields (`thinking` + `thinking.budget_tokens`).

### 3.4 Required Anthropic table coverage

The Anthropic table must include all ids from `packages/core/src/models/anthropic.ts`:

- `claude-opus-4-7`
- `claude-opus-4-6`
- `claude-opus-4-5`
- `claude-opus-4-5-20251201`
- `claude-sonnet-4-6`
- `claude-sonnet-4-5`
- `claude-sonnet-4-5-20250929`
- `claude-haiku-4-5`
- `claude-haiku-4-5-20250929`

Default behavior for unknown Anthropic ids:

- use conservative support (`low|medium|high`)
- treat `xhigh` as unsupported and fallback
- log missing explicit model entry

## 4. Budget preset policy (internal only)

- Presets are runtime-owned (not config-owned).
- Preset names are stable; token counts can be tuned without config migration.
- Example preset classes:
  - `reasoning_low`
  - `reasoning_medium`
  - `reasoning_high`
  - `reasoning_xhigh`

Anthropic model entries select preset ids per level. This is where model-by-model tuning happens.

## 5. TUI behavior

- Status area shows current reasoning with model:
  - `model: anthropic/claude-sonnet-4-5 [high]`
- `/model` picker flow:
  1. provider
  2. model
  3. reasoning (`low|medium|high|xhigh`)

## 6. Non-goals

- Adding reasoning off toggle.
- Exposing raw provider-specific reasoning fields in baseline UI.
- Blocking runs when requested level is unsupported (fallback is preferred).
