# Storage / Usage Spec（Token usage・cost・tool output cache 保存）

この文書は “再現実装として必要な保存/集計” を定義します。

- Token usage の集計（必須）
- cost 計算（任意）
- tool output cache の保存（任意）

---

## 1. Token usage の集計（必須）

### 1.1 目的

- Agent の全 LLM 呼び出しで usage を積算し、`getUsage()` で参照できる
- compaction の判定にも usage を使う

### 1.2 UsageSummary（例）

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

### 1.3 記録タイミング

- `llm.ainvoke()` のたびに `response.usage` を取得できれば記録する
- `total_calls` / `by_model[].calls` は **usage が取得できた呼び出しのみ**増加させる

---

## 2. cost 計算（任意）

Python版は `include_cost` が true のときのみ価格データを取得し、1日キャッシュする。

TS版も同等に:

- `includeCost=false` の場合、外部取得・キャッシュはしない（ゼロ副作用）
- `includeCost=true` の場合、`PricingProvider` から価格情報を取得して cost を計算できる

### 2.1 PricingProvider（提案）

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

`TokenCost` は `PricingProvider` を DI で受け取り、無ければ cost なしで動く。

### 2.2 キャッシュ

- 1日キャッシュ（Python版踏襲）
- 保存先は “実装環境” に合わせて決める（Nodeなら `~/.cache/...` 等）
- キャッシュが壊れても “cost が取れないだけ” で動くこと（堅牢性優先）

---

## 3. tool output cache 保存（任意）

tool output cache は参照IDで再展開するための保存領域。
Node の CLI 実装は「ディレクトリにファイル保存」を提供して良い。

要件:

- 保存は失敗しても agent は動作継続する（ログのみ）
- 保存内容は `ref_id` で一意に識別できる
