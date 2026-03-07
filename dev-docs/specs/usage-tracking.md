# Storage / Usage Spec (Token usage, cost, tool output cache storage)

This document defines “storage/aggregation required as a reproduction implementation”.

- Aggregation of Token usage (required)
- cost calculation (optional)
- Save tool output cache (optional)

---

## 1. Aggregation of Token usage (required)

### 1.1 Purpose

- Usage is accumulated for all LLM calls of the Agent and can be referenced with `getUsage()`
- Use usage to determine compaction

### 1.2 UsageSummary (Example)

```ts
export type UsageSummary = {
  total_calls: number;
  total_tokens: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cached_input_tokens: number;
  total_cache_creation_tokens: number;
  total_cost_usd?: number | null;
  by_model: Record<string, {
    calls: number;
    input_tokens: number;
    output_tokens: number;
    cached_input_tokens: number;
    cache_creation_tokens: number;
    total_tokens: number;
    cost_usd?: number | null;
  }>;
};
```

### 1.3 Recording timing

- Record if you can get `response.usage` every time `llm.ainvoke()`
- `total_calls` / `by_model[].calls` only increase **usage for calls that can be obtained**

---

## 2. Cost calculation (optional)

The Python version retrieves price data only when `include_cost` is true and caches it for one day.

Same for TS version:

- If `includeCost=false`, no external acquisition or caching (zero side effects)
- For `includeCost=true`, cost can be calculated by obtaining price information from `PricingProvider`

### 2.1 PricingProvider (suggestion)

```ts
export type ModelPricing = {
  model: string;
  input_cost_per_token?: number | null;
  output_cost_per_token?: number | null;
  max_tokens?: number | null;
  max_input_tokens?: number | null;
  max_output_tokens?: number | null;
  cache_read_input_token_cost?: number | null;
  cache_creation_input_token_cost?: number | null;
};

export interface PricingProvider {
  getModelPricing(model: string): Promise<ModelPricing | null>;
}
```

`TokenCost` receives `PricingProvider` in DI, and if there is none, it operates without cost.

### 2.2 Caching

- 1 day cache (follows the Python version)
- Decide the save destination according to the “implementation environment” (for example, `~/.cache/...` for Node)
- Even if the cache is corrupted, it will work without cost (prioritize robustness)

---

## 3. Save tool output cache (optional)

tool output cache is a storage area for redeploying with reference ID.
Node's CLI implementation may provide ``save files in directories''.

Requirements:

- The agent continues to operate even if the save fails (log only)
- Saved contents can be uniquely identified by `ref_id`
