# Skills Spec（Discovery / Search / Context Loading）

この文書は、Codelia に Skills（`SKILL.md`）を統合するための仕様を定義する。
特に次の 2 点を主眼にする。

- 対応する skill をどう探索・検索するか
- skill をロードしたときに、どの形でコンテキストへ入れるか

---

## 0. 実装状態（2026-02-08 時点）

この spec は **Partially Implemented**（Phase 1 + Phase 2 主要項目を実装済み）である。

Implemented（このターンで追加）:

- skills 安定型（schema-first）: `packages/shared-types/src/skills/schema.ts`, `packages/shared-types/src/skills/index.ts`
- protocol 拡張（`skills.list` / `context.inspect.include_skills`）:
  `packages/protocol/src/skills.ts`, `packages/protocol/src/context.ts`
- config 拡張（`skills.enabled/initial/search`）:
  `packages/config/src/index.ts`, `packages/runtime/src/config.ts`
- runtime discovery/search/load:
  `packages/runtime/src/skills/resolver.ts`
- tools:
  `packages/runtime/src/tools/skill-search.ts`,
  `packages/runtime/src/tools/skill-load.ts`
- 初期 catalog 注入:
  `packages/runtime/src/agent-factory.ts`
- RPC:
  `packages/runtime/src/rpc/skills.ts`,
  `packages/runtime/src/rpc/context.ts`
- TUI picker（検索 / scope / 有効・無効切替）:
  `crates/tui/src/handlers/command.rs`,
  `crates/tui/src/handlers/panels.rs`,
  `crates/tui/src/main.rs`
- skill 名単位 permissions policy（`permissions.*.skill_name`）:
  `packages/config/src/index.ts`,
  `packages/runtime/src/permissions/service.ts`

---

## 1. Goals / Non-Goals

Goals:

1. Agent Skills 標準の progressive disclosure（一覧は軽く、本文は必要時ロード）を満たす
2. 既存 AGENTS/context-management と衝突せずに skills を統合する
3. 大量 skill がある場合でも prompt 膨張を抑える
4. 明示指定（`$skill-name` / path 指定）に対して決定的に同じ skill を解決する

Non-Goals:

1. runtime がリモートから skill を自動検索/自動取得すること
2. `.claude/skills` 互換探索
3. system scope（admin/system レイヤ）を持つこと
4. UI の見た目・操作詳細（Picker UX）の確定

---

## 2. Standard Baseline

参照標準:

- Agent Skills 仕様: `https://agentskills.io/specification`
- OpenAI Codex Skills ガイド: `https://developers.openai.com/codex/skills/`

採用する標準要件:

1. 1 skill = 1 ディレクトリ + `SKILL.md`
2. `SKILL.md` は YAML frontmatter を持ち、`name` と `description` を必須とする
3. agent へはまず skill catalog（name/description/path）を提示し、本文は on-demand でロードする
4. skill 内の相対パス参照は「skill ディレクトリ基準」で解決する

---

## 3. 先行実装比較と採用方針

### 3.1 codex から採用する点

- 明示メンション解決の厳密性（name 重複時の曖昧性回避、path 優先）
- 構造化された skill 注入フォーマット（`<skill> ... </skill>` 相当）
- skill 検索結果と有効/無効の分離管理

### 3.2 opencode から採用する点

- `skill` tool による on-demand ロード
- ロード時に base directory と同梱ファイル情報を返す運用

### 3.3 codelia の最適化方針（Hybrid）

1. skill 配置は `.agents/skills` に統一する
2. 初期コンテキストへは catalog だけ注入（本文は入れない）
3. skill 本文は `skill_load` tool で必要時のみ注入
4. skill 候補探索専用に `skill_search` tool を追加（大量 skill でもスケール）

---

## 4. 用語と型（Planned）

```ts
export type SkillScope = "repo" | "user";

export type SkillMetadata = {
  id: string;            // canonical path hash (stable in session)
  name: string;
  description: string;
  path: string;          // absolute path to SKILL.md
  dir: string;           // skill base dir
  scope: SkillScope;
  mtimeMs: number;
};

export type SkillLoadError = {
  path: string;
  message: string;
};

export type SkillCatalog = {
  skills: SkillMetadata[];
  errors: SkillLoadError[];
  truncated: boolean;
};

export type SkillSearchResult = {
  skill: SkillMetadata;
  score: number;
  reason: "exact_name" | "exact_path" | "prefix" | "token_overlap";
};
```

Schema 配置（Schema-first）:

- `packages/shared-types/src/skills/schema.ts`: Zod schema
- `packages/shared-types/src/skills/index.ts`: infer type export

---

## 5. Discovery / Search 仕様（Planned）

### 5.1 探索ルート

`workingDir` を起点に、以下のみを探索する。

Repo scope（root -> cwd の祖先連鎖）:

1. `.agents/skills/**/SKILL.md`

User scope:

1. `~/.agents/skills/**/SKILL.md`

### 5.2 ルート推定

Repo の探索境界は AGENTS と同系統に合わせる。

- 優先: `CODELIA_AGENTS_ROOT`
- fallback: marker（既定: `.codelia`, `.git`, `.jj`）

### 5.3 Frontmatter 検証

必須:

- `name`（1..64, `^[a-z0-9]+(-[a-z0-9]+)*$`）
- `description`（1..1024）

推奨:

- `version`, `license`, `metadata`（文字列 map）

追加制約:

- `name` は `SKILL.md` を含むディレクトリ名と一致していること
- 連続ハイフン（`--`）や先頭/末尾ハイフンは不許可

バリデーション失敗時:

- catalog には追加しない
- `SkillLoadError` として `errors[]` に記録

### 5.4 重複解決

- 一意キーは `path`（canonical absolute）
- 同名 skill は保持する（自動上書きしない）
- `name` だけで選ぶ際に同名が複数ある場合は曖昧扱い

### 5.5 検索アルゴリズム

`skill_search(query)` は以下の優先順位でスコアリングする。

1. `exact_path`
2. `exact_name`
3. `name` prefix
4. `name + description` の token overlap

Tie-break:

1. score 降順
2. scope 優先（repo > user）
3. path 昇順

---

## 6. コンテキスト注入仕様（Planned）

### 6.1 初期注入（catalog only）

session 開始時に system prompt へ catalog を追加する。

- 位置: `system(base)` -> `agents_context(initial)` -> `skills_context(initial)`
- 内容: `name`, `description`, `path`, `scope` のみ
- 上限: `skills.initial.maxEntries`, `skills.initial.maxBytes`
- 上限超過時は `truncated: true` を明示し、`skill_search` を使うよう指示

例:

```xml
<skills_context>
<skills_usage>
  <rule>...skill usage guidance...</rule>
</skills_usage>
<skills_catalog scope="initial" truncated="false">
  <skill>
    <name>repo-review</name>
    <description>Review PR with risk-first checklist</description>
    <path>/repo/.agents/skills/repo-review/SKILL.md</path>
    <scope>repo</scope>
  </skill>
  <skill>
    <name>release-notes</name>
    <description>Draft release notes from commits</description>
    <path>/repo/.agents/skills/release-notes/SKILL.md</path>
    <scope>repo</scope>
  </skill>
</skills_catalog>
</skills_context>
```

### 6.2 on-demand ロード

`skill_load` tool の実行結果として本文を注入する。

- 履歴上は通常の ToolMessage
- tool output cache の対象にする
- 以後の compaction では ref を保持可能にする

例:

```xml
<skill_context name="repo-review" path="/repo/.agents/skills/repo-review/SKILL.md">
...SKILL.md full content...

Base directory: file:///repo/.agents/skills/repo-review/
Relative paths in this skill are resolved from this directory.
<skill_files>
<file>/repo/.agents/skills/repo-review/references/checklist.md</file>
<file>/repo/.agents/skills/repo-review/scripts/run.sh</file>
</skill_files>
</skill_context>
```

### 6.3 再ロード抑制

session 内で `loadedVersions(path -> mtimeMs)` を保持する。

- 同一 `path + mtimeMs` の再ロード要求時は本文再送を避ける
- 代わりに短い reminder（既読である旨 + ref 情報）を返す

---

## 7. Tools 仕様（Planned）

### 7.1 `skill_search`

入力:

```ts
{ query: string; limit?: number; scope?: "repo" | "user" }
```

出力:

- 上位候補（name/description/path/scope/reason/score）
- `count`, `truncated`

### 7.2 `skill_load`

入力:

```ts
{ name?: string; path?: string }
```

ルール:

1. `path` があれば最優先
2. `name` のみで一意なら解決
3. `name` が曖昧ならエラー（候補 path を返す）

出力:

- `<skill_context>` テキスト
- metadata: `{ skill_id, name, path, dir, mtime_ms }`

---

## 8. Permissions / Sandbox

### 8.1 skill 名単位 policy（Implemented, Phase 2）

- `permissions.allow` / `permissions.deny` の `tool: "skill_load"` ルールで
  `skill_name`（exact match, lowercase kebab-case）を利用できる
- 評価順は既存と同じで `deny > allow > confirm`
- `skill_name` が未指定の `tool: "skill_load"` ルールは従来どおり tool 全体に一致
- UI confirm の remember は `skill_load` の場合に
  `{ "tool": "skill_load", "skill_name": "<name>" }` を保存する

### 8.2 path 安全性

`skill_load` は次を満たす必要がある。

1. 解決対象は catalog に登録済み path のみ
2. `..` や symlink で skill dir 外へ出ない
3. ファイル列挙は最大件数・最大 byte を制限

---

## 9. Config Schema 拡張（Planned）

```ts
type SkillsConfig = {
  enabled?: boolean;                // default true
  initial?: {
    maxEntries?: number;            // default 200
    maxBytes?: number;              // default 32 * 1024
  };
  search?: {
    defaultLimit?: number;          // default 8
    maxLimit?: number;              // default 50
  };
};
```

統合先:

- `packages/config/src/index.ts`
- `packages/runtime/src/config.ts`

---

## 10. Protocol / Runtime 拡張（Planned）

### 10.1 protocol methods

追加:

- `skills.list`（UI から catalog 一覧取得）

案:

```ts
type SkillsListParams = { cwd?: string; force_reload?: boolean };
type SkillsListResult = { skills: SkillMetadata[]; errors: SkillLoadError[] };
```

### 10.2 context.inspect

`include_skills?: boolean` を追加し、現在 catalog 状態を確認できるようにする。

### 10.3 runtime state

`RuntimeState` に以下を保持する。

- `skillsCatalogByCwd`
- `loadedSkillVersions`

---

## 11. Package Boundaries

- `@codelia/core`:
  - skill transport/探索実装は持たない
  - 既存 tool contract と context-management を利用するのみ

- `@codelia/runtime`:
  - discovery/search/load 実装
  - `skill_search` / `skill_load` tool 提供
  - permission と sandbox の適用

- `@codelia/protocol`:
  - `skills.list` 型追加
  - `context.inspect` 拡張

- `@codelia/shared-types`:
  - skill catalog / result の安定型を管理

---

## 12. リモート探索の扱い

Codelia runtime では、リモート skill の自動検索/自動取得を行わない。

---

## 13. 受け入れ条件（Acceptance）

1. `root -> cwd` 配下の `.agents/skills/**/SKILL.md` が列挙される
2. `~/.agents/skills/**/SKILL.md` が user scope として列挙される
3. 同名 skill が複数ある場合、`name` 単独の `skill_load` は曖昧エラーになる
4. `skill_search("release")` が name/description 由来で候補を返す
5. `skill_load` が `SKILL.md` 本文と base directory を返す
6. 同一 skill の再ロードで本文重複注入を回避できる
7. `context.inspect(include_skills=true)` で catalog 状態を確認できる
8. compaction 後も skill load 済み参照が壊れない

---

## 14. Phase Plan

Phase 1（MVP）:

- local discovery（repo/user の `.agents/skills` のみ）
- `skill_search`, `skill_load`
- initial catalog 注入
- `skills.list` protocol

Phase 2:

- [x] skill 名単位 policy（`permissions.*.skill_name`）
- [x] UI picker 強化（検索・scope 表示・有効/無効切替）
