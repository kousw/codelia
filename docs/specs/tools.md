# Tools Spec（defineTool / zod / DI / serialization / tool output cache）

この文書は Tool（関数ツール）の定義・実行・スキーマ生成の仕様です。
Python版の `@tool` と `Depends` を TS に落とすときの “最小で正しい形” を狙います。

---

## 1. 用語

- Tool: モデルが tool call で呼べる関数。入力は JSON（スキーマで制約）
- Tool definition: LLM に渡す「ツール一覧」（name/description/JSON Schema）
- DI: ツール実行時に依存（DBクライアント等）を解決して注入する仕組み

---

## 2. Tool の基本形（推奨）

### 2.1 defineTool

TS では decorator よりも “データ + 関数” の形が扱いやすい。

```ts
export type DefineToolOptions<TInput, TResult> = {
  name: string;
  description: string;
  input: ZodSchema<TInput>;
  execute: (input: TInput, ctx: ToolContext) => Promise<TResult> | TResult;
};

export type Tool = {
  name: string;
  description: string;
  definition: ToolDefinition;  // parameters は JSON Schema
  executeRaw: (rawArgsJson: string, ctx: ToolContext) => Promise<ToolResult>;
};
```

`executeRaw` を Tool 側に寄せることで、Agent 側は

- JSON parse
- バリデーション
- 例外→ToolMessage化

を “Tool 共通” の実装として扱えます。

### 2.2 ToolContext（DI の受け皿）

```ts
export type ToolContext = {
  signal?: AbortSignal;
  logger?: Logger;
  now?: () => Date;

  // dependency overrides / injection
  deps: Record<string, unknown>;
  resolve: <T>(key: DependencyKey<T>) => Promise<T>;
};
```

Tool は `ctx.resolve(...)` で依存を取り出す（または `ctx.deps` の直参照でも良い）。

---

## 3. JSON Schema 生成（zod → JSON Schema）

### 3.1 目的

- LLM が “正しい引数形” を出せるようにする
- 不正引数は tool 実行前に弾けるようにする（zod validate）

### 3.2 要件

- zod schema から JSON Schema を生成できること
- `additionalProperties: false` 相当の制約を付けられること（できない場合は Tool 側で reject）
- OpenAI strict tool calling を使う場合は “strict互換” を満たすこと（詳細は providers spec）

※ Zod v4 の `toJSONSchema` を利用する（`target: "draft-07"` / `io: "input"`）。

---

## 4. DI（Depends相当）の仕様

Python版の `Depends` が満たしている性質:

- 依存を sync/async どちらでも解決できる
- override（差し替え）が可能

TSでは “依存の解決キー” を明示して扱うのが分かりやすい。

### 4.1 DependencyKey

```ts
export type DependencyKey<T> = {
  id: string;
  create: () => T | Promise<T>;
};

export type DependencyOverrides = Map<string, () => unknown | Promise<unknown>>;
```

### 4.2 resolve のルール

- `overrides` に同じ `id` があればそれを使う
- 無ければ `create()` を呼ぶ
- 値は 1 回の tool call の間はキャッシュして良い（必要なら “per-run” キャッシュ）

CLI では「ファイル操作 root」や「作業ディレクトリ」等を DI で差し替える用途が強い。

---

## 5. Tool result の表現と serialization

### 5.1 ToolResult（内部表現）

```ts
export type ToolResult =
  | { type: 'text'; text: string }
  | { type: 'parts'; parts: (TextPart | ImagePart)[] }
  | { type: 'json'; value: unknown };
```

### 5.2 ToolMessage への変換ルール

- `text` → `ToolMessage.content` は string
- `json` → JSON.stringify（安定化のため）
- `parts` → `ToolMessage.content` は parts

### 5.3 例外時

Tool 例外は `ToolMessage(is_error=true, content="Error executing tool: ...")` に変換する。

---

## 6. Tool output cache（ツール出力キャッシュ）

ツール出力は「できる限りコンテキストに保持」しつつ、合計サイズの上限を超えたら
古い出力からトリムして参照IDを残す。詳細は `docs/specs/context-management.md` を参照。

ToolMessage には `output_ref` が付与される場合がある（参照ID）。

TODO:
- tool_output_cache / tool_output_cache_grep の実装は巨大出力に備えてストリーミング対応する
- tool output cache は content parts（image/document 等）をフル保存する方式も検討する

---

## 7. “標準ツール” の位置づけ

### 7.1 done

- `done` は “終了のためのツール” として推奨
- 必須化はしない（tool call が無い応答で通常終了）

### 7.2 planning（todos）

planning（`write_todos` 等）は core に必須ではないが、CLI の標準ツールとして提供する。

この設計により:

- ライブラリ利用は最小を保てる
- CLI 利用では計画の揮発を抑えられる

### 7.3 tool_output_cache

tool output cache の参照IDから内容を取得する標準ツール。

- name: `tool_output_cache`
- input: `{ ref_id: string, offset?: number, limit?: number }`
- output: 行番号付きテキスト（`read` と同様）

### 7.4 tool_output_cache_grep

tool output cache の参照IDに対して検索を行う標準ツール。

- name: `tool_output_cache_grep`
- input: `{ ref_id: string, pattern: string, regex?: boolean, before?: number, after?: number, max_matches?: number }`
- output: 行番号付きテキスト（`grep` と同様）

---

## 8. Edit tool (enhanced behavior)

The `edit` tool semantics are defined in `docs/specs/edit-tool.md`.
