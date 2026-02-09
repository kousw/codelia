# Permissions Spec

本書は tool 実行時の permission 判定・UI confirm 連携・設定ファイルの仕様を定義する。
初期実装では **Runtime 側で判定**し、Core は UI に依存しない。

---

## 1. Goals / Non-Goals

Goals:
- tool 実行前に必ず permission 判定を挟む
- 既定は **confirm**（UI 確認）
- allowlist に一致した場合のみ confirm をスキップ
- UI confirm 非対応時は **deny**
- bash はコマンド内容を精査する（サブコマンド対応）

Non-Goals:
- ネットワークアクセスなど「実行種別」の正確な判定
- OS レベルの強制（これは sandbox の責務）

---

## 2. 用語

- **Permission decision**: `allow | deny | confirm` のいずれか
- **Rule**: tool / bash command に対する allow / deny 条件
- **System allowlist**: Runtime に組み込む既定 allowlist

---

## 3. Config Schema (`config.json`)

`@codelia/config` に `permissions` を追加する。

```json
{
  "version": 1,
  "permissions": {
    "allow": [
      { "tool": "read" },
      { "tool": "bash", "command": "rg" },
      { "tool": "bash", "command_glob": "git status*" }
    ],
    "deny": [
      { "tool": "bash", "command": "rm" }
    ]
  }
}
```

### 3.1 型定義

```ts
type PermissionRule = {
  tool: string;
  command?: string;        // bash の先頭1〜2語（サブコマンド）
  command_glob?: string;   // bash の全文 glob
  skill_name?: string;     // skill_load の skill 名（exact match）
};

type PermissionsConfig = {
  allow?: PermissionRule[];
  deny?: PermissionRule[];
};
```

### 3.2 ルールの解釈

- `tool` は **必須**。
- `command` / `command_glob` は **bash 専用**。
- `skill_name` は **skill_load 専用**。
- `command` と `command_glob` を **両方指定した場合は AND**。
- `command` / `command_glob` を指定しない場合は tool 全体に一致。
- `skill_name` を指定した `tool: "skill_load"` は指定 skill のみ一致。

---

## 4. Config の読み込み範囲

複数レイヤを **結合**して評価する（配列は連結）。

優先順（後勝ちではなく **連結**）:
1. System allowlist（Runtime 内蔵）
2. Global config（`CODELIA_CONFIG_PATH` or default）
3. Project config（`.codelia/config.json`）

> Project config は将来の実装対象だが、本 spec には含める。

---

## 5. 評価順

判定は以下の順で行う:

1. `deny` に一致 → **deny**
2. `allow` に一致 → **allow**
3. それ以外 → **confirm**

UI confirm が利用不可の場合、`confirm` は **deny** として扱う。

---

## 6. bash 特別扱い

### 6.1 正規化

bash の `command` 入力は評価前に正規化する:
- 先頭/末尾 trim
- 連続スペースを 1 つに畳む

### 6.2 `command` の解釈（サブコマンド対応）

`command` は **先頭 1〜2 語の一致**で判定する。

- ルールが 1 語なら **先頭1語一致**
- ルールが 2 語なら **先頭2語一致**

例:
- `command: "git"` → `git status`, `git push origin main` に一致
- `command: "git push"` → `git push origin main` に一致

### 6.3 `command_glob` の解釈

`command_glob` は **正規化済みの全文**に glob マッチする。

- `*` は任意の文字列
- `?` は任意の1文字
- それ以外は文字通り一致

例:
- `rg*` → `rg -n foo`, `rg    -S bar`
- `git push*` → `git push origin main`

> 正規表現は使わない。glob は `*` と `?` のみをサポートする。

### 6.4 分割と評価（パイプ/連結/リダイレクト演算子）

以下の **演算子でコマンドを分割**して判定する。

- 分割対象: `|`, `||`, `&&`, `;`, `>`, `>>`, `<`, `2>`, `2>>`, `|&`
- **クォート内（`'...'` / `"..."`）やバックスラッシュでエスケープされた演算子は無視**する
- 連続した演算子は **最長一致**で解釈する（例: `|&` は `|` + `&` ではなく `|&`）

判定ルール:

- 正規化後のコマンドを演算子で分割する
- 分割した **各セグメント**に対して permission 判定を行う
- **全セグメントが allow のときのみ自動許可**
- 1 つでも allow できなければ confirm

補足:

- リダイレクトの **右側（例: `/dev/null` や出力先ファイル）はコマンド扱いしない**
  - `command` 判定の対象は左側のコマンドのみ
  - ただし **リダイレクトを含むコマンドを自動許可したい場合は**
    `command_glob` で全文マッチを明示的に許可する（例: `"rg* > /dev/null"`）
- `command_glob` は **分割後セグメント**だけでなく、正規化済みの **全文**にも適用する
  - 全文マッチした場合は allow/deny を即決してよい

> 分割後のセグメント文字列に対して `command` / `command_glob` を適用し、`command_glob` は全文にも適用する。

---

## 7. System allowlist

### 7.1 Tool allowlist

以下は **デフォルトで allow** とする:
- `read`
- `grep`
- `glob_search`
- `todo_read`
- `todo_write`
- `tool_output_cache`
- `tool_output_cache_grep`
- `done`

### 7.2 bash allowlist（最小読取）

以下は **command で allow** とする:
- `pwd`
- `ls`
- `rg`
- `grep`
- `find`
- `sort`
- `cat`
- `head`
- `tail`
- `wc`
- `stat`
- `file`
- `uname`
- `whoami`
- `date`
- `git status`
- `git diff`
- `git show`
- `git log`
- `git rev-parse`
- `git ls-files`
- `git grep`

`cd` は command allowlist ではなく、sandbox からの逸脱がない場合のみ runtime が自動許可する。
sandbox 外へ出る `cd` は confirm する。

---

## 8. UI confirm

`confirm` 判定時は `ui.confirm.request` を使う:

- title: `Run tool?` / `Run command?` など
- message: tool 名 + 主要入力（bash は command 文字列）
- bash の message は **正規化済みの command**（6.1）を使う
- danger_level: `danger` を使える（危険コマンド等）

UI が `supports_confirm=false` の場合は **deny**。
UI は `UiConfirmResult` に以下を任意で含められる:
- `remember: true` の場合、次回以降は confirm をスキップして許可する
  - runtime は in-memory allowlist に追加し、**project config (`.codelia/config.json`) に永続化**する
  - bash の保存粒度:
    - コマンドは 6.4 の分割ルールでセグメントに分解して保存する
    - 各セグメントを `command`（先頭1語、サブコマンド型は先頭2語）として保存する
    - `cd` は動的判定のため永続化しない
- `reason: string` の場合、deny の理由として tool に返す

---

## 9. Error 表現

拒否時は tool の返却を error 扱いにする:

- `ToolMessage.is_error = true`
- `content = "Permission denied: <reason>"`

---

## 10. Examples

### 10.1 すべて confirm（allow なし）

```json
{ "version": 1, "permissions": { "allow": [], "deny": [] } }
```

### 10.2 bash だけ許可

```json
{
  "version": 1,
  "permissions": {
    "allow": [
      { "tool": "bash", "command": "rg" },
      { "tool": "bash", "command_glob": "git status*" }
    ]
  }
}
```

### 10.3 deny 優先

```json
{
  "version": 1,
  "permissions": {
    "allow": [ { "tool": "bash", "command": "rm" } ],
    "deny":  [ { "tool": "bash", "command": "rm" } ]
  }
}
```

### 10.4 skill_load を skill 名単位で制御

```json
{
  "version": 1,
  "permissions": {
    "allow": [{ "tool": "skill_load", "skill_name": "repo-review" }],
    "deny": [{ "tool": "skill_load", "skill_name": "dangerous-skill" }]
  }
}
```

→ `deny` が優先され、`dangerous-skill` の `skill_load` は拒否される。
