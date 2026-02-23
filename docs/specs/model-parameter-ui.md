# Model Parameter UI Spec (No semantic abstraction)

## 0. Status (as of 2026-02-23)

- Status: Planned
- Scope: Runtime + Protocol + TUI parameter editing flow for model-specific settings
- Primary objective: avoid semantic abstraction of optimization-critical model parameters while minimizing UI implementation cost

This spec intentionally does **not** introduce a provider-neutral semantic key (for example, no `thinking_level` abstraction).

---

## 1. Background / Problem

Current state:

- `model.set` only changes `{ provider, name }`.
- Config supports `model.reasoning` and `model.verbosity` as generic strings.
- Runtime currently resolves reasoning/verbosity as `low|medium|high` only for OpenAI/OpenRouter paths.

Issue:

- Tuning quality-critical parameters (reasoning/thinking) is model-dependent.
- Semantic abstraction loses model-specific intent and constraints.
- Hand-coding per-model UI is expensive and does not scale with model churn.

Requirement:

- Keep model-native semantics and parameter names.
- Avoid bespoke UI implementation per model.

---

## 2. Design Principles

1. **No semantic abstraction**
   - Keep provider/model-native parameter meaning and naming in the UX contract.
   - Example: OpenAI `reasoning.effort`, Anthropic `thinking.budget_tokens` remain distinct.

2. **Declarative rendering abstraction only**
   - Unify **how fields are rendered**, not **what they mean**.
   - UI uses schema/profile-driven form rendering.

3. **Model-specific persistence**
   - Parameter values are stored per `(provider, model)`.
   - No cross-model auto-mapping.

4. **Latest-model-first support policy**
   - First-class support is limited to recent models in active use.
   - Older models may fall back to advanced JSON editing.

---

## 3. Terminology

- **Parameter Profile**: Declarative definition of editable fields for a model (or model pattern).
- **Field Key**: Model-native key path (e.g. `reasoning.effort`, `thinking.budget_tokens`).
- **Parameter Values**: User-selected values for a specific model.

---

## 4. Data Model (Protocol-level)

### 4.1 New RPC: `model.parameters.describe` (recommended)

Purpose:

- Return editable parameter profile for a target model.
- Allow UI to render form without hardcoded components.

Params:

```ts
export type ModelParametersDescribeParams = {
  provider?: string; // default: current provider
  name?: string; // default: current model
};
```

Result:

```ts
export type ModelParameterFieldType =
  | "enum"
  | "number"
  | "boolean"
  | "string"
  | "json";

export type ModelParameterField = {
  key: string; // model-native path, e.g. "reasoning.effort"
  type: ModelParameterFieldType;
  label: string;
  description?: string;
  required?: boolean;
  default?: unknown;
  enum_values?: string[];
  minimum?: number;
  maximum?: number;
  step?: number;
  placeholders?: { empty?: string };
  // optional validation hints for future use
  pattern?: string;
};

export type ModelParametersDescribeResult = {
  provider: string;
  name: string;
  profile_version: number;
  fields: ModelParameterField[];
  current_values?: Record<string, unknown>;
  source: "builtin" | "remote";
  generated_at: string; // ISO8601
};
```

### 4.2 New RPC: `model.parameters.set` (recommended)

Purpose:

- Persist model-specific parameter values.

Params:

```ts
export type ModelParametersSetParams = {
  provider?: string;
  name?: string;
  values: Record<string, unknown>; // key path -> value
  clear_missing?: boolean; // default false
};
```

Result:

```ts
export type ModelParametersSetResult = {
  provider: string;
  name: string;
  values: Record<string, unknown>;
};
```

### 4.3 Backward compatibility

- Keep `model.reasoning` / `model.verbosity` as legacy compatibility fields.
- Resolution order for runtime invocation:
  1. `model.parameters[(provider,name)]` (new)
  2. legacy `model.reasoning` / `model.verbosity`
  3. connector default

---

## 5. Config Schema (storage)

Extend config model section with per-model parameter map:

```json
{
  "version": 1,
  "model": {
    "provider": "openai",
    "name": "gpt-5.2-codex",
    "reasoning": "medium",
    "verbosity": "medium",
    "parameters": {
      "openai/gpt-5.2-codex": {
        "reasoning.effort": "xhigh",
        "text.verbosity": "medium"
      },
      "anthropic/claude-sonnet-4.6": {
        "thinking.type": "enabled",
        "thinking.budget_tokens": 16000
      }
    }
  }
}
```

Notes:

- Key format: `<provider>/<model-name>`.
- Values are model-native and are never auto-translated between providers.

---

## 6. Runtime Mapping Rules

Runtime maps stored key paths into provider request payloads at invocation time.

Examples:

- OpenAI/OpenRouter (Responses-like path):
  - `reasoning.effort` -> `request.reasoning.effort`
  - `text.verbosity` -> `request.text.verbosity`

- Anthropic:
  - `thinking.type` -> `request.thinking.type`
  - `thinking.budget_tokens` -> `request.thinking.budget_tokens`

Validation:

- Validate against field definitions from profile before dispatch.
- Reject invalid values with clear path-based error messages.
- Do not silently coerce out-of-range values.

---

## 7. UI/TUI Behavior

1. UI fetches `model.parameters.describe` for selected model.
2. UI renders fields from profile (enum/number/toggle/json).
3. User saves via `model.parameters.set`.
4. If no profile is available, show `Advanced JSON` editor with warning.

UX requirements:

- Explicitly display provider/model in editor header.
- Disable cross-model carry-over by default.
- Show unsupported/deprecated markers when profile changes.

---

## 8. Latest-model-first Support Matrix (initial)

Initial explicit profile coverage target (as of 2026-02-23):

- OpenAI (recent):
  - `gpt-5`, `gpt-5-mini`, `gpt-5-nano`
  - `gpt-5.1`, `gpt-5.1-codex`, `gpt-5.1-codex-max`
  - `gpt-5.2`, `gpt-5.2-codex`, `gpt-5.2-pro`
- Anthropic (recent):
  - `claude-sonnet-4.5`, `claude-sonnet-4.6`
  - `claude-opus-4.5`, `claude-opus-4.6`
  - `claude-haiku-4.5`

Models outside explicit coverage:

- May use fallback profile or `Advanced JSON` mode.

---

## 9. GPT-5 `xhigh` Handling

Policy:

- Include `xhigh` in OpenAI GPT-5 profile options where supported.
- Do not expose `xhigh` for models where profile/source does not support it.

Source notes (verified on 2026-02-23):

- OpenRouter reasoning guide documents `reasoning.effort` levels including `xhigh`.
- OpenAI API reference for runs indicates `xhigh` availability with model-specific constraints (including exceptions/default differences around GPT-5.1 family).

Implementation requirement:

- Encode support at **model-profile granularity** (not provider-wide).
- Treat `xhigh` as opt-in per model profile entry.

---

## 10. Rollout Plan

Phase 1 (MVP):

1. Add config schema support for `model.parameters` map.
2. Add runtime profile registry (builtin static profiles for recent models only).
3. Add `model.parameters.describe` and `model.parameters.set` RPC methods.
4. Implement TUI rendering for enum/number/boolean fields + JSON fallback.

Phase 2:

1. Add per-model validation diagnostics and conflict hints.
2. Integrate provider metadata (`supported_parameters`) as soft hints only.
3. Add import/export for parameter presets by exact model key.

Phase 3:

1. Optional remote profile refresh mechanism with cache.
2. Profile drift detection and user-facing migration prompts.

---

## 11. Non-goals

- Defining a universal reasoning abstraction across providers.
- Forcing parameter parity between OpenAI and Anthropic.
- Supporting all historical models in first rollout.

---

## 12. References

- OpenRouter Reasoning Tokens guide: https://openrouter.ai/docs/guides/best-practices/reasoning-tokens
- OpenRouter models endpoint (used for recent model snapshot verification): https://openrouter.ai/api/v1/models
- Anthropic extended thinking: https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking
- Anthropic OpenAI SDK compatibility (`thinking` in extra body): https://docs.anthropic.com/en/api/openai-sdk
- OpenAI GPT-5 guide: https://platform.openai.com/docs/guides/gpt-5
- OpenAI API reference (runs, `reasoning_effort` notes): https://platform.openai.com/docs/api-reference/runs/getRun
