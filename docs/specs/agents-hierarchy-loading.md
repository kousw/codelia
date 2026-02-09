# AGENTS Hierarchy Loading Spec

この文書は、`AGENTS.md` を「初期コンテキストで安定的に読み込む仕組み」と「作業中に別階層へ移動した際に必要分だけ解決する仕組み」の仕様を定義する。

---

## 0. 定義インデックス

定義が散らばらないよう、この spec で使う主要な `define` をここに集約する。

### 0.1 型定義（公開）

- `AgentsConfigSchema` / `AgentsConfig`: `0.5 最小公開スキーマ（v1）`
- `ResolvedAgentsSchema` / `ResolvedAgents`: `0.5 最小公開スキーマ（v1）`
- `SystemReminderTypeSchema` / `SystemReminderType`: `0.5 最小公開スキーマ（v1）`

### 0.2 実行時状態（内部）

- `covered dirs`: `3. 用語`, `5.3 covered dirs 初期化`
- `loadedVersions(path -> mtimeMs)`: `6.3 コンテキストへの組み込み`

### 0.3 外部注入（env）

- `CODELIA_AGENTS_ROOT`: `4.1 設定`
- `CODELIA_AGENTS_MARKERS`: `4.1 設定`
- `CODELIA_SANDBOX_ROOT`（非対象・用途分離）: `4.2 推定アルゴリズム`

### 0.4 `<system-reminder>` type

- `agents.resolve.paths`（Now）: `11.2`
- `session.resume.diff`（Now）: `11.3`
- `tool.output.trimmed`（Planned）: `11.4`
- `permission.decision`（Planned）: `11.5`

### 0.5 最小公開スキーマ（v1）

```ts
import { z } from "zod";

export const AgentsConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    root: z
      .object({
        projectRootOverride: z.string().optional(),
        markers: z.array(z.string()).optional(),
        stopAtFsRoot: z.boolean().optional(),
      })
      .optional(),
    initial: z
      .object({
        maxFiles: z.number().int().positive().optional(),
        maxBytes: z.number().int().positive().optional(),
      })
      .optional(),
    resolver: z
      .object({
        enabled: z.boolean().optional(),
        maxFilesPerResolve: z.number().int().positive().optional(),
      })
      .optional(),
  })
  .strict();

export type AgentsConfig = z.infer<typeof AgentsConfigSchema>;

export const ResolvedAgentsSchema = z
  .object({
    files: z.array(
      z
        .object({
          path: z.string(),
          mtimeMs: z.number().nonnegative(),
          sizeBytes: z.number().int().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict();

export type ResolvedAgents = z.infer<typeof ResolvedAgentsSchema>;

export const SystemReminderTypeSchema = z.enum([
  "agents.resolve.paths",
  "session.resume.diff",
  "tool.output.trimmed",
  "permission.decision",
]);

export type SystemReminderType = z.infer<typeof SystemReminderTypeSchema>;
```

### 0.6 実装配置（Schema-first）

- `packages/shared-types/src/agents/schema.ts`: `zod` スキーマ定義（唯一の定義源）。
- `packages/shared-types/src/agents/index.ts`: `schema` と `z.infer` 型の再エクスポート。
- 境界（config読込/API/tool I/O）で `Schema.parse` を必須化し、内部では `infer` 型のみ使う。
- 生成物（JSON Schema など）が必要な場合は `schema.ts` から生成し、手書き型を増やさない。

---

## 1. 目的

- ルートから `cwd` までの `AGENTS.md` を初回に確実に読み込む。
- 作業対象パスが変わったときに、必要な祖先 `AGENTS.md` だけ追加解決できるようにする。
- 先頭 system メッセージの変動を抑え、プロンプトキャッシュの安定性を維持する。
- 毎ターンの無駄な `AGENTS.md` 読み込みを防ぐ。

## 2. 非目的

- `AGENTS.md` の文法や優先順位ルール自体（深い階層優先など）の再定義。
- Skill 読み込み仕様の変更。
- 既存の context compaction 仕様の置換。

---

## 3. 用語

- `root`: AGENTS 探索の基点ディレクトリ。
- `initial chain`: `root -> cwd` の祖先列に存在する `AGENTS.md` の順序付き集合。
- `covered dirs`: 現在すでに AGENTS 解決済みとして扱うディレクトリ集合。
- `resolver`: 任意の対象パスから祖先 `AGENTS.md` を解決し、未解決または更新分のメタデータのみ返す処理。

---

## 4. ルート推定

### 4.1 設定

設定型は `AgentsConfigSchema` / `AgentsConfig`（`0.5`）を使用する。

外部注入（任意）:

- `CODELIA_AGENTS_ROOT`: `projectRootOverride` に対応する override。
- `CODELIA_AGENTS_MARKERS`: `markers` に対応するカンマ区切り指定。
- これらは AGENTS 解決専用で、`CODELIA_SANDBOX_ROOT` とは独立して扱う。

### 4.2 推定アルゴリズム

1. `projectRootOverride` が指定されていればそれを `root` とする。
2. 未指定の場合、`cwd` から親へ辿り、`markers` のいずれかが存在する最初の祖先を `root` とする。
3. 見つからない場合は `root = cwd`。

`markers` 未指定時の既定値は `[".codelia", ".git", ".jj"]`。

注記:

- `.codelia` はプロジェクトローカルな marker として扱い、`~/.config` 等のグローバル設定ディレクトリは root 判定対象にしない。
- `projectRootOverride` は AGENTS 探索専用。sandbox の root を表す `CODELIA_SANDBOX_ROOT` とは意味を分離する。

---

## 5. 初期ロード（session start）

### 5.1 読み込み範囲

- `root` から `cwd` までの各ディレクトリを上位から順に走査する。
- 各ディレクトリで `AGENTS.md` があれば採用する。
- 上限は `initial.maxFiles` / `initial.maxBytes` で打ち切る。

### 5.2 メッセージ配置

- 初期 AGENTS バンドルは **system 群の直後** に 1 つの固定メッセージとして挿入する。
- 例: `system(provider) -> system(environment) -> system(agents-initial) -> history...`

```xml
<agents_context scope="initial">
Instructions from: /repo/AGENTS.md
...

Instructions from: /repo/packages/foo/AGENTS.md
...
</agents_context>
```

### 5.3 covered dirs 初期化

- 初期ロードで採用した各 `AGENTS.md` の「親ディレクトリ」を `covered dirs` に登録する。
- 以後の resolver はこの集合を基準に未解決分のみ返す。

---

## 6. 都度 resolver（作業中の別階層対応）

### 6.1 トリガ

- `read/edit/write` 対象が `cwd` 外、または既存 `covered dirs` で覆われないパス。
- ツール呼び出し前に `resolveAgentsForPath(targetPath)` を実行する。

### 6.2 返却仕様

`resolveAgentsForPath` の返却型は `ResolvedAgentsSchema` / `ResolvedAgents`（`0.5`）を使用する。

制約:

- 1 回の resolve で `resolver.maxFilesPerResolve` を超えない。
- 既知ファイルでも `mtimeMs` が変化していれば返す。
- resolver はファイル本文を返さない（本文 read は必要時に別途実行）。

### 6.3 コンテキストへの組み込み

- resolver 結果は「初期 system」には再注入しない。
- 対象ツール結果の末尾に `<system-reminder>` として「候補パスのみ」追加する。

```xml
<system-reminder>
Additional AGENTS.md may apply for this path:
- /repo/feature/AGENTS.md (mtime: 1738970000000)
Read and apply these files before editing files in this scope.
</system-reminder>
```

- 追加後は `covered dirs` と `loadedVersions(path -> mtimeMs)` を更新する。

### 6.4 resolver の責務境界

- resolver は「適用候補の列挙」までを責務とする。
- `AGENTS.md` 本文の取得と適用判断は agent 側（`read` 実行）で行う。
- これにより resolver 自体の返却サイズ増大を防ぐ。

---

## 7. キャッシュ安定性ポリシー

- 初期 `system(agents-initial)` はセッション中に不変とする（再生成しない）。
- 追加 AGENTS は tool output 側 (`<system-reminder>`) に寄せ、本文は埋め込まない。
- これにより「先頭メッセージが毎ターン変わる」状態を避ける。

---

## 8. プロンプト調整

モデルへの基礎指示に以下を追加する。

1. すでに初期 AGENTS が渡されている前提で、毎ターン AGENTS 探索を行わないこと。
2. 新しい対象パスを読む/編集する場合のみ resolver を使うこと。
3. resolver が返したパスは必要時に自分で `read` し、その内容を適用すること。
4. 同一パスに対する重複 read を避けること。
5. session resume 時に `<system-reminder type="session.resume.diff">` があれば、その差分を優先して反映すること。

---

## 9. 受け入れ基準

1. session 開始時、`root -> cwd` の AGENTS が順序通り 1 回だけ初期注入される。
2. 別階層のファイルを read したとき、必要な祖先 AGENTS の「パス + mtime」のみが `<system-reminder>` で追加される。
3. 同一階層の再 read で AGENTS が重複注入されない。
4. 初期 system メッセージがターンを跨いで変化しない。
5. `projectRootOverride` と `markers` による root 推定の切替が機能する。
6. 既知 `AGENTS.md` の更新（mtime 変化）時は resolver で再提示される。

---

## 10. 実装メモ（推奨）

- `packages/core` に `agentsResolver` を置き、初期ロードと都度解決を同一実装で扱う。
- 返却値の `mtimeMs` を `loadedVersions` に保存し、更新検知に使う。
- `docs/specs/context-management.md` の tool 出力トリム時、`<system-reminder>` が欠落しないよう扱いを明示する（別PRで詳細化）。

---

## 11. `<system-reminder>` カタログ（v1）

この節は「会話中に追加注入する軽量メタ情報」のフォーマットを定義する。

### 11.1 共通ルール

- 位置: 対象ツール出力または resume 直後の追記メッセージとして付与する。
- 原則: path / id / 状態差分のみを入れ、巨大本文を入れない。
- 形式: `type` 属性を必須にする。

```xml
<system-reminder type="...">
...
</system-reminder>
```

### 11.2 `agents.resolve.paths`（Now）

用途:

- 対象パスに対して追加で適用候補となる `AGENTS.md` を通知する。

内容:

- `path`
- `mtimeMs`

例:

```xml
<system-reminder type="agents.resolve.paths">
Additional AGENTS.md may apply for this path:
- /repo/feature/AGENTS.md (mtime: 1738970000000)
- /repo/feature/sub/AGENTS.md (mtime: 1738971000000)
Read and apply these files before editing files in this scope.
</system-reminder>
```

### 11.3 `session.resume.diff`（Now）

用途:

- 再開時に、前回セッションから変わった実行文脈を通知する。

内容:

- `cwd` の差分
- `root` の差分
- `markers` の差分
- 追加で確認が必要な `AGENTS.md` の `path + mtimeMs`

例:

```xml
<system-reminder type="session.resume.diff">
Session resumed with context changes:
- cwd: /repo/a -> /repo/b
- root: /repo -> /repo
- markers: [".codelia",".git",".jj"] -> [".codelia",".git",".jj"]
Re-check AGENTS.md for current scope:
- /repo/b/AGENTS.md (mtime: 1738973000000)
</system-reminder>
```
