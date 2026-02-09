# Model Metadata Spec（models.dev）

This document is a specification for the function that "obtains meta information such as context window / input/output limits from model name".
The main purpose is to obtain the information required for token threshold calculation in Compaction.

The reference data uses models.dev.

---

## 1. Purpose

- Enable to obtain model upper limit information from one public data source
- Used to determine the context limit of compaction (context window / max input / max output)
- Make the structure extensible for future uses (UI display, pricing, feature flags)

---

## 2. Data source

### 2.1 models.dev API

- API endpoint: `https://models.dev/api.json`
- Model ID is an identifier used by AI SDK
- `limit.context / limit.input / limit.output` exists in the model schema

### 2.2 Target field

- `limit.context`: Maximum context length
- `limit.input`: Maximum input token
- `limit.output`: Maximum output token

Other items (pricing/modalities/feature flags) are for future expansion.

---

## 3. Type definition

```ts
export type ModelLimits = {
	contextWindow?: number; // limit.context
	maxInputTokens?: number; // limit.input
	maxOutputTokens?: number; // limit.output
	source: "models.dev";
updatedAt?: string; // If there is an update date on the data side, keep it
};

export type ModelMetadataIndex = {
	// provider -> modelId -> limits
	models: Record<string, Record<string, ModelLimits>>;
};

export type ModelMetadataProvider = {
	getModelLimits(params: {
		provider: ProviderName;
		model: string;
	}): Promise<ModelLimits | null>;
};
```

---

## 4. Acquisition/caching strategy

### 4.1 Fetch

- Get models.dev API on first access
- Parse JSON using `fetch()`
- If acquisition fails, treat it as an error on the caller side (assuming strict operation)

### 4.2 Cache

- In-memory cache (TTL default: 24h)
- If TTL expires, it will be reacquired on the next access.
- Node implementation uses `@codelia/storage` and stores in `cache/models.dev.json` (default)
- Provide an optional extension point for persistent cache (e.g. file cache with runtime)

```ts
export type ModelMetadataCache = {
	read: () => Promise<ModelMetadataIndex | null> | ModelMetadataIndex | null;
	write: (index: ModelMetadataIndex) => Promise<void> | void;
};
```

---

## 5. Normalization and resolution rules

### 5.1 Provider Name Consistency

- `ProviderName` assumes `openai | anthropic | google` of core
- Map assuming that the Provider ID of models.dev matches
- Ignore unsupported providers (to be expanded in the future)

### 5.2 Model ID alignment

Model IDs in models.dev may contain the `provider/model` format.
Since `ModelSpec.id` on the Agent SDK side is a short ID like `gpt-5`, it is matched using the following rules.

1. Generate `fullId = `${provider}/${modelId}`
2. Search for `index.models[provider][fullId]` with priority
3. Then search for `index.models[provider][modelId]`
4. If not found, `null`

This results in:
- This can be solved even if models.dev is managed by `openai/gpt-5`
- Even if the SDK side adopts `openai/gpt-5` in the future, it will continue to work as is.

---

## 6. Apply to existing ModelRegistry

### 6.1 Reflection policy

Overwrite the obtained result in `ModelSpec` (add only if there is no static definition).

```ts
export function applyModelMetadata(
	registry: ModelRegistry,
	index: ModelMetadataIndex,
): ModelRegistry {
// Assumed to return a shallow clone that does not destroy the existing ModelSpec
}
```

- `contextWindow` ← `limit.context`
- `maxOutputTokens` ← `limit.output`
- `maxInputTokens` should be added to `ModelSpec` or referenced directly on compaction side

### 6.2 Priority

1. Prefer static `ModelSpec` if it has a value
2. If not available, complete with the value of models.dev

---

## 7. Integration with Compaction

`CompactionService.shouldCompact()` determines the context limit with the following precedence:

1. `ModelSpec.contextWindow` (static or completed with models.dev)
2. `ModelSpec.maxInputTokens`
3. Error (strict) if it cannot be obtained. The premise is to obtain metadata externally and enrich the registry.

This organizes the conductors up to compaction.

---

## 8. Error Fallback

- Failure to obtain models.dev is **fatal** (strict). Treated as an error on the outside.
- Console logs are only at debug level (no unnecessary noise for users)

---

## 9. Testing policy (minimum)

- Save sample JSON of models.dev as fixture
- `applyModelMetadata()` of
- fullId / shortId resolution
- Overwrite priority
- Skip unknown models
verify

---

## 10. Non-goal

- No price calculation or price display will be performed at this stage.
- Automatic addition of Provider (dynamic generation of registry itself) is not performed.
