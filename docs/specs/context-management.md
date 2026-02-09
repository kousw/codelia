# Context Management Spec（tool output cache / compaction）

この文書は「会話コンテキストが肥大して壊れる」問題に対する 2 つの仕組みを定義します。

- tool output cache: ツール出力を可能な限り保持し、上限を超えたら古い出力をトリムして参照IDを残す
- compaction: トークンしきい値で履歴を要約に置換

---

## 1. Tool Output Cache（ツール出力キャッシュ）

### 1.1 目的

- DOM/スクショ/大量ログなどの出力でコンテキストが爆発するのを防ぐ
- ただし “直近は必要” なので可能な限りツール出力を保持する
- 必要時に参照IDから即座に再展開できること

### 1.2 用語

- tool output cache: ツール出力のフル内容を保存するキャッシュ
- in-context view: モデルに送る出力（必要に応じてトリム済み）
- output ref: キャッシュ参照ID（`ToolOutputRef`）

### 1.3 設定（ToolOutputCacheConfig）

```ts
export type ToolOutputCacheConfig = {
  enabled?: boolean;          // default true
  contextBudgetTokens?: number | null; // null = model context 由来
  maxMessageBytes?: number;   // default 50 * 1024
  maxLineLength?: number;     // default 2000
};
```

`contextBudgetTokens` が `null` の場合は以下で算出する:

```
budget = clamp(context_window * 0.25, 20_000, 60_000)
```

トークンは実 tokenizer が無い場合、byte/4 の近似で良い。

### 1.4 ToolOutputRef

```ts
export type ToolOutputRef = {
  id: string;
  byte_size?: number;
  line_count?: number;
};
```

ToolMessage は必要に応じて `output_ref` を持つ（参照ID）。

### 1.5 キャッシュ保存

ツール出力が発生したら:

1. フル内容を tool output cache に保存し `ToolOutputRef` を得る
2. in-context view を生成して ToolMessage にセットする
3. ToolMessage に `output_ref` を保持する

### 1.6 in-context view の生成

- 1行 `maxLineLength` でカット
- 合計 `maxMessageBytes` を超える場合は打ち切る
- 打ち切った場合は「続きは参照IDで展開できる」旨を末尾に付与する

### 1.7 合計サイズ超過時のトリム

ツール出力の合計トークン推定が `contextBudgetTokens` を超えた場合:

1. 直近のツール出力を優先して保持する（古い順に候補化）
2. 古い ToolMessage の `content` をプレースホルダに置換
3. `output_ref` は残し、必要なら `tool_output_cache` で展開できる

プレースホルダ例: `"[tool output trimmed; ref=...]"`.

### 1.8 展開（tool_output_cache）

参照IDから内容を再取得するための標準ツールを用意する:

```
tool_output_cache({ ref_id, offset?, limit? })
```

`offset/limit` は行ベースで扱う。返り値は `read` 相当の行番号付きテキスト。
検索用途には `tool_output_cache_grep` を用意する（tools spec 参照）。

### 1.9 GC（オプション）

compaction 等で参照されなくなった `ToolOutputRef` は削除対象にできる。

### 1.10 TODO（将来改善）

- `tool_output_cache` の read/grep は巨大出力を想定してストリーミング対応する
- tool output cache は content parts（image/document 等）をフル保持する方式も検討する

---

## 2. Compaction（要約置換）

### 2.1 目的

- 長い会話・多数の tool calls を “要約” に置換し、作業を継続できるようにする
- モデルの context window を越える前に自動で行う

### 2.2 設定（CompactionConfig）

```ts
export type CompactionConfig = {
  enabled?: boolean;         // default true
  auto?: boolean;            // default true（false なら自動 compaction を抑止）
  thresholdRatio?: number;   // default 0.8
  model?: string | null;     // optional: 要約に使うモデル
  summaryPrompt?: string;    // default: Python版に準拠（<summary>タグ）
  summaryDirectives?: string[]; // optional: 要約時の追加指示（append）
  retainPrompt?: string | null;  // optional: retain 指示（<retain>タグ）
  retainDirectives?: string[];   // optional: retain 追記（append）
  retainLastTurns?: number;      // default 1（直近Nターンは保持）
};
```

### 2.3 トークン使用量（TokenUsage）

Python版の計算を踏襲する:

- total = input + cache_creation + cache_read + output

```ts
export type TokenUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  total_tokens: number; // computed
};
```

`ChatInvokeUsage` から `TokenUsage` を作れること。

### 2.4 context limit の決定

- 価格/モデル情報から `max_input_tokens` or `max_tokens` を取得できれば使う
- 取得できない場合はエラー（strict）。外側で metadata を取得して registry を enrich する前提。

threshold = contextLimit * thresholdRatio

### 2.5 shouldCompact

- `enabled=false` → false
- `auto=false` → false（自動判定は無効）
- `tokenUsage.total_tokens >= threshold` → true

### 2.6 compact（要約の生成）

要約生成の手順:

1. messages を “要約用に整形” する
2. 割り込みメッセージ（retain+summary 指示）を `UserMessage` として末尾に追加
3. LLM を tool なしで呼ぶ（`tools=null`）
4. 返ってきた text から `<retain>...</retain>` と `<summary>...</summary>` を抽出
5. 割り込みメッセージと LLM 応答は履歴に残さない

#### 2.6.1 要約用の整形（重要）

Python版は “末尾 assistant が tool_calls を持つ状態” を要約に入れると tool/result の対応が崩れて API error になるため、末尾の assistant tool_calls を取り除く。

TS版も同等の処理を行う:

- messages の最後が `AssistantMessage(tool_calls!=empty)` の場合:
  - `content` があれば “tool_calls無しのAssistantMessage(contentのみ)” に置換
  - `content` が無ければメッセージを落とす（要約対象に入れない）

#### 2.6.2 compaction.model の優先

要約生成時は `CompactionConfig.model` を優先して LLM を選ぶ。

- `model` が指定されている場合: 要約呼び出しはそのモデルを使う
- `model` が `null`/未指定の場合: 通常の LLM（呼び出し元の model）を使う

用途: 低コストモデルで要約する / 長い文脈を扱えるモデルで要約する。

#### 2.6.3 summaryDirectives（追加指示）

`summaryDirectives` がある場合、summary prompt の末尾に箇条書きで追記する。
既存の prompt を置換せず「重要情報を残す指示を追加する」用途を想定する。

#### 2.6.4 retainPrompt / retainDirectives

`retainPrompt` がある場合、割り込みメッセージ内で `<retain>` セクションの指示に使う。
`retainDirectives` は箇条書きで追記する。
用途: 「残すべき情報（ツール出力の ref や重要な判断）を列挙」させる。

### 2.7 checkAndCompact（履歴の置換）

compaction が発動した場合:

- 履歴全体を “retain + summary + 直近Nターン” に差し替える
- retain は `UserMessage` として先頭に挿入する
- summary は `UserMessage(content=summary)` とする
- `retainLastTurns` がある場合は直近Nターンを残す

#### 2.7.1 provider 固有の履歴キャッシュの再構築

OpenAI など provider 固有の履歴バッファを持つ実装では、compaction 後に
「送信に使う履歴キャッシュ」を `compactedMessages` から再構築すること。

- view messages の差し替えだけでは送信履歴が縮まらない
- OpenAIHistoryAdapter の `inputItems` は `compactedMessages` を変換し直す
- 以前の provider 出力アイテムは要約後の履歴と整合しないため破棄する

### 2.8 Agent ループへの組み込み

Python版のタイミングを踏襲:

- 各 LLM 呼び出しの後（usage が取れた後）に compaction 判定ができる
- tool 実行後にも compaction を呼ぶ（ただし判定は “最後の usage” を使う）
- 終了直前（final return 前）にも compaction を 1 回通す

---

## 3. 学びながら実装するためのチェックポイント

最初の実装は “本物の token count” が無くても良い（MockModel で固定値を返せば良い）。

1. tool output cache が合計サイズ上限を超えたときに古い出力をトリムできること
2. トリム済み ToolMessage が serializer で placeholder になること
3. compaction が threshold を超えたら履歴を retain + summary に置換すること
4. 末尾 assistant の tool_calls を除去しないと壊れる、という現象をテストで再現できること
