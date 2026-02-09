# Model Metadata Spec（models.dev）

この文書は「モデル名から context window / 入出力上限などのメタ情報を取得する」機能の仕様です。
Compaction でのトークンしきい値計算に必要な情報取得を主目的とします。

参照元データは models.dev を採用します。

---

## 1. 目的

- 1つの公開データソースから、モデルの上限情報を取得できるようにする
- compaction の context limit 決定に使う（context window / max input / max output）
- 将来の用途（UI表示、価格、機能フラグ）にも拡張可能な構造にする

---

## 2. データソース

### 2.1 models.dev API

- API エンドポイント: `https://models.dev/api.json`
- Model ID は AI SDK で使われる識別子
- モデルスキーマには `limit.context / limit.input / limit.output` が存在する

### 2.2 対象フィールド

- `limit.context`: 最大コンテキスト長
- `limit.input`: 最大入力トークン
- `limit.output`: 最大出力トークン

他の項目（pricing / modalities / feature flags）は将来の拡張向け。

---

## 3. 型定義

```ts
export type ModelLimits = {
	contextWindow?: number; // limit.context
	maxInputTokens?: number; // limit.input
	maxOutputTokens?: number; // limit.output
	source: "models.dev";
	updatedAt?: string; // データ側の更新日があれば保持
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

## 4. 取得・キャッシュ戦略

### 4.1 Fetch

- 初回アクセス時に models.dev API を取得
- `fetch()` を利用し JSON をパース
- 取得に失敗した場合は呼び出し側でエラーとして扱う（strict 運用を前提）

### 4.2 キャッシュ

- メモリ内キャッシュ（TTL 既定: 24h）
- TTL 切れ時は次回アクセスで再取得
- Node 実装は `@codelia/storage` を使い `cache/models.dev.json` に保存する（既定）
- 永続キャッシュは任意で差し込める拡張点を用意する（例: runtime でファイルキャッシュ）

```ts
export type ModelMetadataCache = {
	read: () => Promise<ModelMetadataIndex | null> | ModelMetadataIndex | null;
	write: (index: ModelMetadataIndex) => Promise<void> | void;
};
```

---

## 5. 正規化と解決ルール

### 5.1 Provider 名の整合

- `ProviderName` は core の `openai | anthropic | google` を想定
- models.dev の Provider ID が一致する前提でマップする
- 未対応プロバイダは無視（将来的に拡張）

### 5.2 Model ID の整合

models.dev の Model ID には `provider/model` 形式が含まれる場合がある。
Agent SDK 側の `ModelSpec.id` が `gpt-5` のような短い ID のため、次のルールで照合する。

1. `fullId = `${provider}/${modelId}` を生成
2. `index.models[provider][fullId]` を優先で検索
3. 次に `index.models[provider][modelId]` を検索
4. 見つからなければ `null`

これにより:
- models.dev が `openai/gpt-5` で管理していても解決できる
- SDK 側が将来 `openai/gpt-5` を採用してもそのまま動く

---

## 6. 既存 ModelRegistry への適用

### 6.1 反映方針

`ModelSpec` に取得結果を上書きする（静的定義が無い場合のみ追加）。

```ts
export function applyModelMetadata(
	registry: ModelRegistry,
	index: ModelMetadataIndex,
): ModelRegistry {
	// 既存の ModelSpec を破壊しない shallow clone を返す想定
}
```

- `contextWindow` ← `limit.context`
- `maxOutputTokens` ← `limit.output`
- `maxInputTokens` は `ModelSpec` に追加するか、compaction 側で直接参照する

### 6.2 優先順位

1. 静的 `ModelSpec` に値がある場合は優先
2. 無い場合は models.dev の値で補完

---

## 7. Compaction との統合

`CompactionService.shouldCompact()` は次の優先で context limit を決定する:

1. `ModelSpec.contextWindow`（静的 or models.dev で補完済み）
2. `ModelSpec.maxInputTokens`
3. 取得不能ならエラー（strict）。外側で metadata を取得して registry を enrich する前提。

これにより compaction までの導線が整理される。

---

## 8. エラー・フォールバック

- models.dev の取得失敗は **致命的**（strict）。外側でエラーとして扱う。
- コンソールログは debug レベルのみ（ユーザには不要なノイズを出さない）

---

## 9. テスト方針（最小）

- models.dev のサンプル JSON を fixture として保存
- `applyModelMetadata()` の
  - fullId / shortId 解決
  - 上書き優先順位
  - 未知モデルはスキップ
  を検証する

---

## 10. 非目標

- 価格計算や料金表示はこの段階では行わない
- Provider の自動追加（registry 自体を動的生成する）は行わない
